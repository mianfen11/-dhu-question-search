"""Build static search data from collector/Python JSON; no network or credentials."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

try:
    from . import question_bank as base
except ImportError:
    import question_bank as base

FORMAT = 'dhu-search-v1'
REASONS = {'invalid_type': '题型无法识别', 'missing_question': '题干缺失',
           'invalid_options': '选项格式无效或内容冲突', 'missing_options': '选项不足',
           'invalid_answer': '答案缺失或无法可靠映射', 'ambiguous_judge': '判断题字母选项含义不明确'}


def clean(value):
    try:
        return base.text(value)
    except (ValueError, TypeError):
        return ''


def canonical(value):
    # Do not erase punctuation in identities/answers: 3.5 and 35 must stay different.
    return re.sub(r'\s+', ' ', unicodedata.normalize('NFKC', value)).strip()


def ordered_unique(values):
    seen = set()
    result = []
    for value in values:
        key = base.digest(value)
        if key not in seen:
            result.append(value)
            seen.add(key)
    return result


def scalar_answer(value):
    if value is None or isinstance(value, (str, bool, int, float)):
        return value
    if isinstance(value, list) and all(v is None or isinstance(v, (str, bool, int, float)) for v in value):
        return value
    return None


def safe_option_value(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [safe_option_value(v) for v in value]
    return {'invalid_option_value': True}  # Preserve invalidity without copying arbitrary nested fields.


def option_input(value):
    """Keep readable option forms, not arbitrary objects nested in imported data."""
    if isinstance(value, dict):
        result = {str(k): safe_option_value(v) for k, v in value.items()
                  if re.fullmatch(r'[A-Za-z0-9]', unicodedata.normalize('NFKC', str(k)))}
        if len(result) != len(value):
            result['?'] = '不支持的选项字段'
        return result
    if isinstance(value, list):
        return [{'key': clean(base.first(v, 'key', 'label', 'id')),
                 'value': safe_option_value(base.first(v, 'value', 'text', 'content'))} if isinstance(v, dict) else safe_option_value(v) for v in value]
    return safe_option_value(value)


def evidence(row, filename, index):
    contexts = [{'manual_id': clean(row.get('manual_id')) or None,
                 'chapter_id': clean(row.get('chapter_id')) or None}]
    if isinstance(row.get('contexts'), list):
        contexts.extend({'manual_id': clean(c.get('manual_id')) or None,
                         'chapter_id': clean(c.get('chapter_id')) or None}
                        for c in row['contexts'] if isinstance(c, dict))
    contexts = [c for c in contexts if c['manual_id'] or c['chapter_id']]
    ids = [clean(base.first(row, 'question_id', 'id'))]
    if isinstance(row.get('question_ids'), list):
        ids.extend(clean(v) for v in row['question_ids'])
    explanations = [clean(row.get(k)) for k in ('source', 'analysis', 'explanation')]
    if isinstance(row.get('explanations'), list):
        explanations.extend(clean(v) for v in row['explanations'])
    return {'file': Path(filename).name, 'index': index, 'contexts': ordered_unique(contexts),
            'question_ids': sorted(set(filter(None, ids))),
            'source': clean(row.get('source')), 'analysis': clean(row.get('analysis')),
            'explanations': sorted(set(filter(None, explanations)))}


def version(row, filename, index):
    question = clean(base.first(row, 'question', 'question_content', 'stem', 'title'))
    kind = clean(base.first(row, 'question_type', 'type'))
    original_kind = kind
    kind = base.ALIASES.get(kind, kind)
    reason = None
    if kind not in base.TYPES:
        kind, reason = 'unknown', 'invalid_type'
    if not question:
        reason = 'missing_question'
    raw_answer = scalar_answer(base.first(row, 'answer', 'answers', 'correct_answer'))
    options = {}
    fields = {label: safe_option_value(base.first(row, label, label.lower(), 'option_' + label.lower())) for label in base.LABELS
              if base.first(row, label, label.lower(), 'option_' + label.lower()) is not None}
    supplied_options = option_input(row.get('options'))
    try:
        option_row = row
        if kind == 'judge' and row.get('options') == {'1': '正确', '0': '错误'}:
            option_row = {k: v for k, v in row.items() if k != 'options'}
        options = base.options_for(option_row)
    except (ValueError, TypeError):
        reason = reason or 'invalid_options'
        # Keep individually readable options even when the complete structure is bad.
        if isinstance(supplied_options, dict):
            options.update({unicodedata.normalize('NFKC', k).upper(): clean(v) for k, v in supplied_options.items()
                            if unicodedata.normalize('NFKC', k).upper() in base.LABELS and clean(v)})
        for label, value in fields.items():
            if clean(value):
                options.setdefault(label, clean(value))
    if not reason and kind == 'judge' and options:
        reason = 'ambiguous_judge'
    if kind == 'judge' and not options:
        options = {'1': '正确', '0': '错误'}
    if not reason and kind != 'judge' and len(options) < 2:
        reason = 'missing_options'
    labels, texts = [], []
    if not reason:
        try:
            normalized = base.normalize(row)  # Reuse the existing, tested format rules.
            options, labels = normalized['options'], normalized['answer']
            texts = [options[label] for label in labels]
        except (ValueError, TypeError):
            reason = 'invalid_answer'
    return {'question': question, 'question_type': kind, 'original_question_type': original_kind,
            'options': options, 'option_input': supplied_options, 'option_fields': fields,
            'answer_labels': labels, 'answer_texts': texts, 'original_answer': raw_answer,
            'mapping_status': 'unverified' if reason else 'mapped', 'reason': reason,
            'sources': [evidence(row, filename, index)]}


def validate_previous(document):
    if not isinstance(document, dict) or document.get('format') != FORMAT or document.get('schema_version') != 1:
        raise ValueError('--merge 仅接受本工具生成的网站题库')
    if not isinstance(document.get('questions'), list):
        raise ValueError('历史题库 questions 格式异常')
    versions = []
    for question in document['questions']:
        if not isinstance(question, dict) or not isinstance(question.get('variants'), list):
            raise ValueError('历史题库缺少版本信息，停止覆盖')
        for v in question['variants']:
            if not isinstance(v, dict) or not isinstance(v.get('sources'), list):
                raise ValueError('历史题库版本格式异常')
            # Recompute mappings instead of trusting old mapped/conflict flags or text.
            row = {'question': v.get('question'), 'question_type': v.get('original_question_type', v.get('question_type')),
                   'options': v.get('option_input'), 'answer': v.get('original_answer'), **v.get('option_fields', {})}
            rebuilt = version(row, 'previous', 0)
            if rebuilt['mapping_status'] != v.get('mapping_status') or rebuilt['answer_texts'] != v.get('answer_texts'):
                raise ValueError('历史题库答案映射校验失败，停止覆盖')
            rebuilt['sources'] = []
            for source in v['sources']:
                if not isinstance(source, dict) or not isinstance(source.get('file'), str) or not isinstance(source.get('index'), int):
                    raise ValueError('历史题库来源格式异常')
                rebuilt['sources'].append(evidence({
                    'contexts': source.get('contexts', []), 'question_ids': source.get('question_ids', []),
                    'source': source.get('source'), 'analysis': source.get('analysis'),
                    'explanations': source.get('explanations', [])}, source['file'], source['index']))
            versions.append(rebuilt)
    return versions


def retain_missing_stems(value):
    """Only repair recognizable records inside the already supported envelopes."""
    if isinstance(value, list):
        return [retain_missing_stems(v) for v in value]
    if not isinstance(value, dict):
        return value
    if any(k in value for k in ('question', 'question_content', 'stem', 'title')):
        return value
    containers = ('questions', 'items', 'data', 'chapters', 'one_choice', 'multi_choice', 'judge')
    if not any(k in value for k in containers) and any(k in value for k in ('options', 'answer', 'answers', 'correct_answer', *base.LABELS)):
        return {**value, 'question': ''}
    return {k: retain_missing_stems(v) if k in containers else v for k, v in value.items()}


def build_documents(documents, previous=None):
    versions = validate_previous(previous) if previous is not None else []
    for filename, document in documents:
        try:
            rows = list(base.unpack(retain_missing_stems(document)))
        except (ValueError, TypeError) as exc:
            raise ValueError(f'{Path(filename).name}: 输入结构无法识别，未写入题库') from exc
        versions.extend(version(row, filename, index) for index, row in enumerate(rows))
    grouped = {}
    for v in versions:
        identity = [v['question_type'], canonical(v['question'])]
        # Missing stems cannot safely be merged just because both are blank.
        if not v['question']:
            identity.append({k: v[k] for k in ('options', 'original_answer')})
        key = base.digest(identity)
        q = grouped.setdefault(key, {'id': key, 'question_type': v['question_type'],
                                    'question': v['question'], 'variants': {}})
        fingerprint = base.digest({k: v[k] for k in v if k != 'sources'})
        if fingerprint in q['variants']:
            q['variants'][fingerprint]['sources'] = ordered_unique(q['variants'][fingerprint]['sources'] + v['sources'])
        else:
            q['variants'][fingerprint] = {**v, 'sources': ordered_unique(v['sources'])}
    questions = []
    for q in grouped.values():
        q['variants'] = sorted(q['variants'].values(), key=lambda v: base.digest({k: v[k] for k in v if k != 'sources'}))
        q['question'] = min((v['question'] for v in q['variants']), key=lambda text: (len(text), text))
        for v in q['variants']:
            v['sources'].sort(key=base.digest)
        known = {tuple(sorted({canonical(t) for t in v['answer_texts']}))
                 for v in q['variants'] if v['mapping_status'] == 'mapped'}
        has_unverified = any(v['mapping_status'] != 'mapped' for v in q['variants'])
        q['has_unverified'] = has_unverified
        q['status'] = 'conflict' if len(known) > 1 else 'unverified' if has_unverified else 'verified'
        # Only verified groups have a definitive answer. All other candidates stay in variants.
        q['answer_texts'] = next((v['answer_texts'] for v in q['variants'] if v['mapping_status'] == 'mapped'), []) if q['status'] == 'verified' else []
        questions.append(q)
    questions.sort(key=lambda q: q['id'])
    report = {'input_records': len(versions), 'unique_questions': len(questions),
              'mapped_answer_records': sum(v['mapping_status'] == 'mapped' for v in versions),
              'conflict_questions': sum(q['status'] == 'conflict' for q in questions),
              'unverified_questions': sum(q['has_unverified'] for q in questions)}
    return {'schema_version': 1, 'format': FORMAT, 'questions': questions, 'report': report}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', type=Path, nargs='*')
    parser.add_argument('-o', '--output', type=Path, required=True)
    parser.add_argument('--merge', type=Path, help='合并已有的网站题库；允许与输出路径相同，原子写入')
    parser.add_argument('--empty', action='store_true', help='显式生成空库，不加入示例题')
    args = parser.parse_args(argv)
    if not args.inputs and not args.merge and not args.empty:
        parser.error('需要输入文件，或显式指定 --empty')
    if args.empty and (args.inputs or args.merge):
        parser.error('--empty 不能与输入或 --merge 同时使用')
    if args.output.resolve() in {p.resolve() for p in args.inputs}:
        parser.error('不能覆盖原始输入文件')
    try:
        def read(path):
            with path.open(encoding='utf-8-sig') as stream:
                return json.load(stream)
        documents = [(str(path), read(path)) for path in args.inputs]
        result = build_documents(documents, read(args.merge) if args.merge else None)
        args.output.parent.mkdir(parents=True, exist_ok=True)
        temporary = None
        try:
            with tempfile.NamedTemporaryFile('w', encoding='utf-8', dir=args.output.parent, delete=False) as stream:
                temporary = stream.name
                json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
                stream.write('\n')
            os.replace(temporary, args.output)
        finally:
            if temporary and os.path.exists(temporary):
                os.unlink(temporary)
    except (OSError, ValueError, TypeError) as exc:
        parser.exit(1, f'转换失败：{exc}\n')
    print(json.dumps(result['report'], ensure_ascii=False))
    return 0  # Conflicts/unverified records are retained and flagged, not discarded.


if __name__ == '__main__':
    raise SystemExit(main())
