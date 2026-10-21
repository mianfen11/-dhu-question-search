"""Offline, dependency-free question JSON normalization. Never fetches remote data."""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import os
from pathlib import Path
import re
import tempfile
import unicodedata

TYPES = {'one_choice', 'multi_choice', 'judge'}
ALIASES = {'单选': 'one_choice', '单选题': 'one_choice', 'single': 'one_choice',
           '多选': 'multi_choice', '多选题': 'multi_choice', 'multiple': 'multi_choice',
           '判断': 'judge', '判断题': 'judge', 'boolean': 'judge'}
LABELS = 'ABCDE'


def text(value):
    if value is None:
        return ''
    if not isinstance(value, (str, int, float)) or isinstance(value, bool):
        raise ValueError('文本字段必须是字符串或数字')
    return html.unescape(unicodedata.normalize('NFC', str(value))).replace('\r\n', '\n').replace('\r', '\n').strip()


def first(row, *keys):
    for key in keys:
        if key in row and row[key] is not None:
            return row[key]
    return None


def identifier(value):
    return None if value is None else text(value) or None


def unpack(value, context=None):
    """Only traverse documented envelopes; never harvest arbitrary nested arrays."""
    context = dict(context or {})
    if isinstance(value, list):
        for item in value:
            yield from unpack(item, context)
        return
    if not isinstance(value, dict):
        raise ValueError('输入必须是题目对象、数组或受支持的封装对象')
    context.update({k: value[k] for k in ('manual_id', 'chapter_id', 'question_type') if value.get(k) is not None})
    if any(k in value for k in ('question', 'question_content', 'stem', 'title')):
        yield {**context, **value}
        return
    if 'code' in value and value['code'] not in (200, '200', 0, '0'):
        raise ValueError('拒绝导入非成功 API 响应')
    if 'status' in value and value['status'] is False:
        raise ValueError('拒绝导入失败响应')
    for key in ('questions', 'items', 'data'):
        if key in value:
            yield from unpack(value[key], context)
            return
    groups = [key for key in TYPES if key in value]
    if groups:
        for key in sorted(groups):
            yield from unpack(value[key], {**context, 'question_type': key})
        return
    if 'chapters' in value and isinstance(value['chapters'], list):
        for chapter in value['chapters']:
            yield from unpack(chapter, context)
        return
    raise ValueError('无法识别 JSON 结构；支持数组、data/questions/items、chapters 和题型分组')


def options_for(row):
    result = {}
    source = row.get('options')
    if source is not None:
        if isinstance(source, dict):
            pairs = source.items()
        elif isinstance(source, list):
            pairs = []
            for i, option in enumerate(source):
                if isinstance(option, dict):
                    pairs.append((first(option, 'key', 'label', 'id'), first(option, 'value', 'text', 'content')))
                else:
                    if i >= len(LABELS):
                        raise ValueError('选项超过 A～E')
                    pairs.append((LABELS[i], option))
        else:
            raise ValueError('options 必须是对象或数组')
        for key, value in pairs:
            label = unicodedata.normalize('NFKC', text(key)).upper()
            if label not in LABELS or len(label) != 1:
                raise ValueError(f'不支持的选项标签 {label!r}')
            if label in result and result[label] != text(value):
                raise ValueError(f'重复选项 {label} 内容冲突')
            result[label] = text(value)
    for label in LABELS:
        value = first(row, label, label.lower(), 'option_' + label.lower())
        if value is not None and text(value):
            if label in result and result[label] != text(value):
                raise ValueError(f'选项 {label} 内容冲突')
            result[label] = text(value)
    return {k: result[k] for k in LABELS if result.get(k)}


def answer_for(value, kind, options):
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith('['):
            try:
                value = json.loads(stripped)
            except json.JSONDecodeError as exc:
                raise ValueError('答案 JSON 数组无效') from exc
    values = value if isinstance(value, list) else [value]
    if kind == 'judge':
        if len(values) != 1:
            raise ValueError('判断题必须有且只有一个答案')
        raw = values[0]
        if isinstance(raw, bool):
            return ['1' if raw else '0']
        raw = unicodedata.normalize('NFKC', text(raw)).lower()
        truth = {'1', 'true', '正确', '对', '是', '√', '✓'}
        falsehood = {'0', 'false', '错误', '错', '否', '×', '✗'}
        if raw not in truth | falsehood:
            raise ValueError('无法识别判断题答案；不推断 A/B 的真假映射')
        return ['1' if raw in truth else '0']
    answers = []
    for raw in values:
        raw = unicodedata.normalize('NFKC', text(raw)).upper()
        if not raw or not re.fullmatch(r'[A-E\s,，、;；|/]+', raw):
            raise ValueError('选择题答案必须由 A～E 字母组成；不推断数字索引')
        answers.extend(re.findall('[A-E]', raw))
    answers = sorted(set(answers))
    if not answers or (kind == 'one_choice' and len(answers) != 1):
        raise ValueError('答案数量与题型不符')
    if any(label not in options for label in answers):
        raise ValueError('答案引用不存在的选项')
    return answers


def normalize(row):
    kind = text(first(row, 'question_type', 'type'))
    kind = ALIASES.get(kind, kind)
    if kind not in TYPES:
        raise ValueError('缺少或不支持的 question_type')
    question = text(first(row, 'question', 'question_content', 'stem', 'title'))
    if not question:
        raise ValueError('题干为空')
    option_row = row
    if kind == 'judge' and row.get('options') == {'1': '正确', '0': '错误'}:
        option_row = {k: v for k, v in row.items() if k != 'options'}
    options = options_for(option_row)
    if kind != 'judge' and len(options) < 2:
        raise ValueError('选择题至少需要两个选项')
    # The site's judge UI explicitly maps 1/0 to true/false. Do not invent A/B.
    if kind == 'judge':
        if options:
            raise ValueError('判断题带有字母选项，需人工确认映射')
        options = {'1': '正确', '0': '错误'}
    answer = answer_for(first(row, 'answer', 'answers', 'correct_answer'), kind, options)
    explanation = text(first(row, 'explanation', 'analysis', 'source'))
    return {'question_id': identifier(first(row, 'question_id', 'id')),
            'manual_id': identifier(row.get('manual_id')),
            'chapter_id': identifier(row.get('chapter_id')),
            'question_type': kind, 'question': question, 'options': options,
            'answer': answer, 'explanation': explanation}


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def import_documents(documents):
    questions, rejected, conflicts = [], [], []
    by_content, by_identity = {}, {}
    seen = 0
    for filename, document in documents:
        try:
            rows = list(unpack(document))
        except ValueError as exc:
            rejected.append({'file': filename, 'index': None, 'error': str(exc), 'raw': document})
            continue
        for index, row in enumerate(rows):
            seen += 1
            provenance = {'file': filename, 'index': index}
            try:
                q = normalize(row)
            except (ValueError, TypeError) as exc:
                rejected.append({**provenance, 'error': str(exc), 'raw': row})
                continue
            identity = (q['manual_id'], q['question_id']) if q['question_id'] else None
            # Keep chapters/manuals separate; never merge records solely by question_id.
            content = {k: q[k] for k in ('manual_id', 'chapter_id', 'question_type', 'question', 'options', 'answer')}
            fingerprint = digest(content)
            if identity and identity in by_identity and by_identity[identity] != fingerprint:
                conflicts.append({**provenance, 'question_id': q['question_id'],
                                  'error': '同一手册的 question_id 对应不同内容；保留两条记录'})
            if identity:
                by_identity[identity] = fingerprint
            evidence = {**provenance, 'question_id': q['question_id'], 'raw': row}
            if fingerprint in by_content:
                existing = by_content[fingerprint]
                existing['provenance'].append(evidence)
                if q['explanation'] and q['explanation'] not in existing['explanations']:
                    existing['explanations'].append(q['explanation'])
                continue
            q['record_id'] = fingerprint
            q['provenance'] = [evidence]
            q['explanations'] = [q['explanation']] if q['explanation'] else []
            by_content[fingerprint] = q
            questions.append(q)
    # Different answers for the same stem/options must remain visible for review.
    stems = {}
    for q in questions:
        stem = digest({k: q[k] for k in ('manual_id', 'chapter_id', 'question_type', 'question', 'options')})
        if stem in stems and stems[stem]['answer'] != q['answer']:
            conflicts.append({'record_ids': [stems[stem]['record_id'], q['record_id']],
                              'error': '同题不同答案；保留两条记录'})
        stems[stem] = q
    counts = {kind: sum(q['question_type'] == kind for q in questions) for kind in sorted(TYPES)}
    return {'schema_version': 1, 'questions': questions,
            'report': {'input_records': seen, 'unique_records': len(questions),
                       'duplicates_merged': seen - len(questions) - sum(r['index'] is not None for r in rejected),
                       'counts_by_type': counts, 'rejected': rejected, 'conflicts': conflicts,
                       'completeness': 'unverified', 'public_reuse_permission': 'unverified'}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('inputs', nargs='+', type=Path)
    parser.add_argument('-o', '--output', required=True, type=Path)
    args = parser.parse_args(argv)
    if args.output.resolve() in {p.resolve() for p in args.inputs}:
        parser.error('输出文件不能覆盖输入文件')
    documents = []
    try:
        for path in args.inputs:
            with path.open(encoding='utf-8-sig') as stream:
                documents.append((str(path), json.load(stream)))
    except (OSError, ValueError) as exc:
        parser.exit(1, f'输入读取失败：{exc}\n')
    result = import_documents(documents)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=args.output.parent,
                                         delete=False) as stream:
            temporary = stream.name
            json.dump(result, stream, ensure_ascii=False, indent=2, allow_nan=False)
            stream.write('\n')
        os.replace(temporary, args.output)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)
    report = result['report']
    print(json.dumps({k: v for k, v in report.items() if k not in ('rejected', 'conflicts')}, ensure_ascii=False))
    print(f"拒绝记录/文件：{len(report['rejected'])}；冲突：{len(report['conflicts'])}")
    return 2 if report['rejected'] or report['conflicts'] or not result['questions'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
