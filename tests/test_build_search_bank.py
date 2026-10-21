import copy
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from tools import build_search_bank as tool
from tools import question_bank as base


def row(**changes):
    return {'question_id': 1, 'manual_id': '1', 'chapter_id': '1', 'question_type': 'one_choice',
            'question': '学生因病无法参加期末考试，应办理什么手续？',
            'A': '办理缓考手续', 'B': '直接缺考', 'answer': 'A', **changes}


def build(*rows):
    return tool.build_documents([('collector.json', {'code': 200, 'data': list(rows)})])


class SearchBankTests(unittest.TestCase):
    def test_single_choice_full_answer(self):
        bank = build(row())
        q = bank['questions'][0]
        self.assertEqual(q['answer_texts'], ['办理缓考手续'])
        self.assertEqual(q['status'], 'verified')
        self.assertEqual(q['variants'][0]['answer_labels'], ['A'])
        self.assertEqual(bank['report']['mapped_answer_records'], 1)

    def test_multichoice_maps_all_texts(self):
        for answer in ['AC', 'C、A', ['C', 'A'], '["A","C"]']:
            q = build(row(question_type='multi_choice', C='及时提交申请', answer=answer))['questions'][0]
            self.assertEqual(q['answer_texts'], ['办理缓考手续', '及时提交申请'])

    def test_judge(self):
        for answer, expected in [(True, '正确'), ('1', '正确'), (0, '错误'), ('false', '错误')]:
            raw = {'question': '这是一道判断题', 'question_type': 'judge', 'answer': answer}
            self.assertEqual(build(raw)['questions'][0]['answer_texts'], [expected])

    def test_normalized_extension_judge(self):
        raw = {'question': '这是判断题', 'question_type': 'judge', 'options': {'1': '正确', '0': '错误'}, 'answer': ['0']}
        self.assertEqual(build(raw)['questions'][0]['answer_texts'], ['错误'])

    def test_reordered_options_and_changed_answer_letter_are_not_conflict(self):
        q = build(row(), row(A='直接缺考', B='办理缓考手续', answer='B'))['questions'][0]
        self.assertEqual(q['status'], 'verified')
        self.assertEqual(len(q['variants']), 2)
        self.assertEqual(q['answer_texts'], ['办理缓考手续'])
        self.assertEqual({tuple(v['answer_labels']) for v in q['variants']}, {('A',), ('B',)})

    def test_multichoice_reordered_answer_set(self):
        q = build(row(question_type='multi_choice', C='申请', answer='AC'),
                  row(question_type='multi_choice', A='申请', C='办理缓考手续', answer='CA'))['questions'][0]
        self.assertEqual(q['status'], 'verified')
        self.assertEqual(len(q['variants']), 2)

    def test_true_answer_conflict_never_has_definitive_answer(self):
        bank = build(row(), row(answer='B'))
        q = bank['questions'][0]
        self.assertEqual(q['status'], 'conflict')
        self.assertEqual(q['answer_texts'], [])
        self.assertEqual(bank['report']['conflict_questions'], 1)
        self.assertEqual({tuple(v['answer_texts']) for v in q['variants']}, {('办理缓考手续',), ('直接缺考',)})

    def test_changed_options_same_correct_text_remain_versions(self):
        q = build(row(), row(B='另一种错误选项'))['questions'][0]
        self.assertEqual(q['status'], 'verified')
        self.assertEqual(len(q['variants']), 2)

    def test_missing_options_and_bad_answer_are_retained(self):
        for raw in [row(B=None), row(answer='E'), row(answer=None), row(answer=2), row(answer='不确定')]:
            q = build(raw)['questions'][0]
            self.assertEqual(q['status'], 'unverified')
            self.assertEqual(q['answer_texts'], [])
            self.assertEqual(len(q['variants']), 1)

    def test_unverified_version_does_not_disappear_next_to_known_answer(self):
        q = build(row(), row(answer='E'))['questions'][0]
        self.assertEqual(q['status'], 'unverified')
        self.assertEqual(q['answer_texts'], [])
        self.assertEqual(len(q['variants']), 2)

    def test_conflict_plus_unverified_are_both_counted(self):
        bank = build(row(), row(answer='B'), row(answer=None))
        self.assertEqual(bank['report']['conflict_questions'], 1)
        self.assertEqual(bank['report']['unverified_questions'], 1)

    def test_missing_stem_unknown_type_and_ambiguous_judge_retained(self):
        for raw in [row(question=''), row(question_type='not_a_type'), row(question_type='judge')]:
            q = build(raw)['questions'][0]
            self.assertEqual(q['status'], 'unverified')

    def test_metadata_and_sources_without_credentials(self):
        raw = row(source='出处', analysis='解析', contexts=[{'manual_id': '1', 'chapter_id': '2'}],
                  question_ids=['1', '2'], cookie='private-credential', Authorization='private-credential')
        bank = build(raw)
        source = bank['questions'][0]['variants'][0]['sources'][0]
        self.assertEqual(source['question_ids'], ['1', '2'])
        self.assertEqual(source['analysis'], '解析')
        self.assertEqual(len(source['contexts']), 2)
        self.assertNotIn('private-credential', json.dumps(bank))

    def test_extension_export_and_python_export_compatibility(self):
        normalized = base.normalize(row())
        extension = {'schema_version': 1, 'questions': [{**normalized, 'question_ids': ['1'], 'explanations': ['解析']}], 'report': {}}
        converted = tool.build_documents([('extension.json', extension)])
        python_export = base.import_documents([('raw.json', [row()])])
        other = tool.build_documents([('python.json', python_export)])
        self.assertEqual(converted['questions'][0]['answer_texts'], other['questions'][0]['answer_texts'])

    def test_repeated_inputs_and_incremental_merge_are_idempotent(self):
        bank = build(row(), row(chapter_id='2'))
        for _ in range(3):
            merged = tool.build_documents([('collector.json', {'data': [row(), row(chapter_id='2')]})], bank)
            self.assertEqual(merged['questions'], bank['questions'])
            bank = merged
        new = tool.build_documents([('new.json', [row(answer='B')])], bank)
        self.assertEqual(new['questions'][0]['status'], 'conflict')

    def test_answer_punctuation_and_case_are_not_erased(self):
        self.assertEqual(build(row(A='3.5'), row(A='35'))['questions'][0]['status'], 'conflict')
        self.assertEqual(build(row(A='mW'), row(A='MW'))['questions'][0]['status'], 'conflict')

    def test_ambiguous_option_forms_survive_incremental_merge(self):
        raw = row(options={'A': '另一个内容', 'B': '直接缺考'})
        bank = build(raw)
        q = bank['questions'][0]
        self.assertEqual(q['status'], 'unverified')
        self.assertEqual(q['variants'][0]['option_input']['A'], '另一个内容')
        self.assertEqual(q['variants'][0]['option_fields']['A'], '办理缓考手续')
        merged = tool.build_documents([('collector.json', {'data': [raw]})], bank)
        self.assertEqual(merged['questions'], bank['questions'])

    def test_option_width_and_invalid_scalar_forms_remain_mergeable(self):
        for raw in [row(options={'Ａ': '办理缓考手续', 'Ｂ': '直接缺考'}, A=None, B=None),
                    row(A=False), row(A={'unexpected': 'not-copied'}),
                    row(options={'A': '办理缓考手续', 'B': '直接缺考', 'secret-key': 'not-copied'})]:
            bank = build(raw)
            merged = tool.build_documents([('collector.json', {'data': [raw]})], bank)
            self.assertEqual(merged['questions'], bank['questions'])
            self.assertNotIn('not-copied', json.dumps(bank))

    def test_record_without_stem_key_is_retained_for_review(self):
        raw = row()
        del raw['question']
        bank = build(raw, row())
        self.assertEqual(len(bank['questions']), 2)
        missing = next(q for q in bank['questions'] if not q['question'])
        self.assertEqual(missing['status'], 'unverified')
        self.assertEqual(missing['variants'][0]['original_answer'], 'A')

    def test_whitespace_versions_choose_stable_display_text(self):
        raw = [row(question='学校  规定'), row(question='学校 规定')]
        bank = build(*raw)
        merged = tool.build_documents([('collector.json', raw)], bank)
        self.assertEqual(merged['questions'], bank['questions'])
        self.assertEqual(bank['questions'][0]['question'], '学校 规定')

    def test_empty_bank(self):
        bank = tool.build_documents([])
        self.assertEqual(bank['questions'], [])
        self.assertTrue(all(v == 0 for v in bank['report'].values()))

    def test_bad_envelope_and_damaged_previous_fail(self):
        with self.assertRaises(ValueError):
            tool.build_documents([('denied.json', {'code': 401, 'data': [row()]})])
        bank = build(row())
        bank['questions'][0]['variants'][0]['answer_texts'] = ['伪造答案']
        with self.assertRaises(ValueError):
            tool.build_documents([], bank)

    def test_cli_atomic_merge_and_failed_input_never_overwrite(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory) / 'input.json', Path(directory) / 'bank.json'
            source.write_text('\ufeff' + json.dumps([row()]), encoding='utf-8')
            command = [sys.executable, 'tools/build_search_bank.py', str(source), '-o', str(output)]
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 0)
            self.assertEqual(subprocess.run(command + ['--merge', str(output)], capture_output=True).returncode, 0)
            before = output.read_bytes()
            source.write_text('invalid JSON', encoding='utf-8')
            self.assertEqual(subprocess.run(command, capture_output=True).returncode, 1)
            self.assertEqual(before, output.read_bytes())

    def test_production_bank_has_no_synthetic_questions(self):
        bank = json.loads(Path('web/question-bank.json').read_text(encoding='utf-8'))
        self.assertEqual(bank['format'], tool.FORMAT)
        self.assertEqual(bank['report']['unique_questions'], len(bank['questions']))
        self.assertNotIn('synthetic-fixture-not-for-publication.json', json.dumps(bank))
        tool.validate_previous(bank)


if __name__ == '__main__':
    unittest.main()
