import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildIndex, search, normalize, termsFor, highlightRanges } from '../../web/search.js';
import { validateBank } from '../../web/bank.js';
export function buildBank(rows) {
  const py = spawnSync('python3', ['-c', 'import json,sys;from tools.build_search_bank import build_documents;print(json.dumps(build_documents([("synthetic-fixture-not-for-publication.json",json.load(sys.stdin))]),ensure_ascii=False))'], { input: JSON.stringify(rows), encoding: 'utf8' });
  assert.equal(py.status, 0, py.stderr); return JSON.parse(py.stdout);
}
const row = updates => ({ question_type: 'one_choice', question: '学生因病无法参加期末考试，应按照学校规定办理什么手续？', A: '办理缓考手续', B: '直接缺考', answer: 'A', ...updates });
const bank = buildBank([row(), row({ question: '学校奖学金的评定条件是什么？', A: '综合测评达到要求' }), row({ question: '考试纪律要求', A: '遵守考场规则' })]);
const questions = validateBank(bank), index = buildIndex(questions);
const query = text => search(index, text).map(hit => questions.find(q => q.id === hit.id).question);
for (const phrase of ['无法参加考试', '办理手续', '期末考试', '无法参加期末']) {
  test('continuous or gapped Chinese phrase: ' + phrase, () => assert.ok(query(phrase)[0].includes('因病')));
}
test('multiple Chinese keywords support arbitrary order and surplus spaces', () => {
  assert.deepEqual(query('  因病   期末考试  '), query('期末考试 因病'));
  assert.equal(query('因病 期末考试').length, 1);
});
test('punctuation and width differences are normalized', () => {
  assert.deepEqual(query('因病，期末考试！'), query('因病 期末考试'));
  assert.equal(normalize('Ａ，Ｂ  Ｃ。'), 'abc');
  assert.deepEqual(termsFor('    ，  '), []);
});
test('searches options as well as stems', () => assert.ok(query('综合测评')[0].includes('奖学金')));
test('stem matches outrank option-only matches and complete phrases outrank n-gram matches', () => {
  const b = buildBank([row({ question: '办理缓考手续的要求是什么？' }), row({ question: '什么情况可申请？' }), row({ question: '办理什么缓考及其他手续' })]);
  const found = search(buildIndex(b.questions), '办理缓考手续');
  const stems = found.map(hit => b.questions.find(q => q.id === hit.id).question);
  assert.equal(stems[0], '办理缓考手续的要求是什么？');
});
test('more keyword evidence changes relevance without requiring the original order', () => {
  const b = buildBank([row(), row({ question: '期末考试参加条件', A: '因病可申请' })]);
  const found = search(buildIndex(b.questions), '因病 期末考试');
  assert.ok(b.questions.find(q => q.id === found[0].id).question.includes('无法参加'));
});
test('empty, punctuation-only, no-result and single-character queries are safe', () => {
  assert.deepEqual(search(buildIndex([]), '考试'), []);
  assert.deepEqual(query(' '), []); assert.deepEqual(query('？'), []); assert.deepEqual(query('火星飞船'), []);
  assert.ok(query('病').length > 0);
});
test('highlights full, punctuation-normalized and gapped matches with original offsets', () => {
  const text = '学生因病，无法参加期末考试。';
  const values = highlightRanges(text, '无法参加考试').map(([start, end]) => text.slice(start, end));
  assert.deepEqual(values, ['无法参加', '考试']);
  assert.deepEqual(highlightRanges('Ａ，Ｂ', 'ab'), [[0, 3]]);
  assert.deepEqual(highlightRanges('<img onerror=evil>', '<img>'), [[1, 4]]);
});
test('derived data validates answer texts rather than trusting status/report counts', () => {
  const b = buildBank([row(), row({ A: '直接缺考', B: '办理缓考手续', answer: 'B' })]);
  assert.equal(validateBank(b)[0].status, 'verified');
  const corruptions = [
    q => { q.answer_texts = ['错误内容']; },
    q => { q.variants[0].answer_texts = ['错误内容']; },
    q => { q.variants[0].original_answer = 'E'; },
    q => { q.variants[0].question = '另一道题目'; }
  ];
  for (const change of corruptions) { const copy = structuredClone(b); change(copy.questions[0]); assert.throws(() => validateBank(copy)); }
  b.report.unique_questions = 99999; assert.equal(validateBank(b).length, 1);
});
test('conflicts and uncertain versions never expose a definitive answer', () => {
  for (const second of [row({ answer: 'B' }), row({ answer: 'E' })]) {
    const b = buildBank([row(), second]); validateBank(b);
    assert.deepEqual(b.questions[0].answer_texts, []);
    b.questions[0].answer_texts = ['办理缓考手续']; assert.throws(() => validateBank(b));
  }
});
test('large index stays local, complete, and fast without creating result DOM', () => {
  const many = Array.from({ length: 12000 }, (_, i) => ({ ...questions[0], id: String(i), question: `学生期末考试规定 第${i}条`, variants: [{ ...questions[0].variants[0], question: `学生期末考试规定 第${i}条` }] }));
  const start = performance.now(), large = buildIndex(many), found = search(large, '期末 考试');
  assert.equal(found.length, 12000);
  assert.ok(performance.now() - start < 5000, 'bounded 12k-record index/search smoke check');
});
