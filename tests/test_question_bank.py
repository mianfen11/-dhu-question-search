import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from tools.question_bank import answer_for, import_documents, normalize, unpack


def sample(**updates):
    return {**dict(question_id=1, manual_id=1, chapter_id=1, question_type='one_choice',
                   question='题目', A='选项一', B='选项二', answer='A', source='解析'), **updates}


class ImportTests(unittest.TestCase):
    def test_observed_fields(self):
        q = normalize(sample())
        self.assertEqual((q['answer'], q['explanation'], q['question_id']), (['A'], '解析', '1'))

    def test_multiple_formats(self):
        for raw in ['A,C,E', 'ace', 'Ａ，Ｃ、Ｅ', 'A C E', ['E', 'C', 'A', 'A'], '["A","C","E"]', 'A;C|E']:
            with self.subTest(raw=raw):
                self.assertEqual(answer_for(raw, 'multi_choice', dict.fromkeys('ABCDE')), ['A', 'C', 'E'])

    def test_judge_formats(self):
        for raw in [True, 1, '1', 'true', '正确', '对', '✓', ['1']]:
            self.assertEqual(answer_for(raw, 'judge', {}), ['1'])
        for raw in [False, 0, '0', 'false', '错误', '错', '×']:
            self.assertEqual(answer_for(raw, 'judge', {}), ['0'])
        for raw in ['A', 'B', 2, None, [], [True, False]]:
            with self.assertRaises(ValueError): answer_for(raw, 'judge', {})

    def test_options(self):
        for opts in [dict(zip('ABCDE', ['一', '二', '三', '四', '五'])), ['一', '二', '三', '四', '五'],
                     [dict(key=k, value=v) for k, v in zip('ABCDE', ['一', '二', '三', '四', '五'])]]:
            q = normalize({'type': '单选题', 'stem': '问题', 'options': opts, 'correct_answer': 'ｅ'})
            self.assertEqual(q['answer'], ['E'])
            self.assertEqual(q['options']['E'], '五')

    def test_invalid(self):
        for change in [dict(answer='C'), dict(answer='AB'), dict(answer='选项一'), dict(answer=0),
                       dict(answer=None), dict(question=' '), dict(question_type='unknown'),
                       dict(options={'F': '六'}), dict(options={'A': '冲突'})]:
            with self.subTest(change=change), self.assertRaises(ValueError): normalize(sample(**change))

    def test_cleaning(self):
        q = normalize(sample(question='  &lt;b&gt;题目&lt;/b&gt;\r\n第二行  ', source='**解析**'))
        self.assertEqual(q['question'], '<b>题目</b>\n第二行')
        self.assertEqual(q['explanation'], '**解析**')

    def test_context_and_wrappers(self):
        row = {'question': '问题', 'A': '甲', 'B': '乙', 'answer': 'A'}
        data = {'manual_id': 1, 'chapters': [{'chapter_id': 2, 'one_choice': [row]}]}
        result = import_documents([('nested.json', data)])
        self.assertEqual(result['questions'][0]['chapter_id'], '2')
        self.assertEqual(result['questions'][0]['question_type'], 'one_choice')
        for key in ['data', 'questions', 'items']:
            self.assertEqual(len(list(unpack({key: [sample()]}))), 1)

    def test_bad_envelopes(self):
        for data in [{'code': 401, 'data': [sample()]}, {'detail': '鉴权不通过'}, {'unexpected': []}]:
            result = import_documents([('bad', data)])
            self.assertFalse(result['questions'])
            self.assertEqual(len(result['report']['rejected']), 1)

    def test_dedup(self):
        result = import_documents([('a', [sample()]), ('b', [sample(question_id=99, source='另一个解析')])])
        self.assertEqual(result['report']['duplicates_merged'], 1)
        q = result['questions'][0]
        self.assertEqual(q['explanations'], ['解析', '另一个解析'])
        self.assertEqual([p['question_id'] for p in q['provenance']], ['1', '99'])
        self.assertEqual(q['provenance'][1]['raw']['source'], '另一个解析')

    def test_conflicts(self):
        result = import_documents([('a', [sample(), sample(answer='B')])])
        self.assertEqual(len(result['questions']), 2)
        self.assertEqual(len(result['report']['conflicts']), 2)

    def test_manual_scope(self):
        result = import_documents([('a', [sample(), sample(manual_id=2, answer='B')])])
        self.assertEqual(len(result['questions']), 2)
        self.assertFalse(result['report']['conflicts'])

    def test_reject_preserved(self):
        result = import_documents([('a', [sample(), sample(answer='Z')])])
        self.assertEqual(result['report']['input_records'], 2)
        self.assertEqual(result['report']['duplicates_merged'], 0)
        self.assertEqual(result['report']['rejected'][0]['raw']['answer'], 'Z')

    def test_roundtrip(self):
        original = import_documents([('a', [sample(), sample(question_type='multi_choice', question_id=2, answer='BA'),
                                           dict(question_type='judge', question='判断题', answer=True)])])
        restored = import_documents([('export', original)])
        self.assertEqual(restored['report']['unique_records'], 3)
        self.assertFalse(restored['report']['rejected'])
        self.assertEqual([q['record_id'] for q in original['questions']], [q['record_id'] for q in restored['questions']])

    def test_cli(self):
        with tempfile.TemporaryDirectory() as directory:
            source, output = Path(directory)/'in.json', Path(directory)/'out.json'
            def run():
                return subprocess.run([sys.executable, 'tools/question_bank.py', str(source), '-o', str(output)], capture_output=True)
            source.write_text('\ufeff' + json.dumps([sample()]), encoding='utf-8')
            self.assertEqual(run().returncode, 0)
            self.assertEqual(json.loads(output.read_text())['report']['unique_records'], 1)
            source.write_text(json.dumps([sample(answer='Z')]))
            self.assertEqual(run().returncode, 2)
            old = output.read_bytes()
            source.write_text('{invalid json')
            self.assertEqual(run().returncode, 1)
            self.assertEqual(output.read_bytes(), old)
            result = subprocess.run([sys.executable, 'tools/question_bank.py', str(source), '-o', str(source)], capture_output=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(source.read_text(), '{invalid json')


if __name__ == '__main__': unittest.main()
