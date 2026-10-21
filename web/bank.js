/* Fail closed on damaged derived data, including incorrect definitive answers. */
function object(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function text(v) { return typeof v === 'string'; }
const kinds = ['one_choice', 'multi_choice', 'judge', 'unknown'];
const canonical = v => v.normalize('NFKC').replace(/\s+/gu, ' ').trim();
const answerKey = values => JSON.stringify([...new Set(values.map(canonical))].sort());
function labelsFor(value, kind) {
  try {
    if (typeof value === 'string' && value.trim().startsWith('[')) value = JSON.parse(value);
    const values = Array.isArray(value) ? value : [value];
    if (kind === 'judge') {
      if (values.length !== 1) return null;
      const v = String(values[0]).normalize('NFKC').toLowerCase().trim();
      if (['1', 'true', '正确', '对', '是', '√', '✓'].includes(v)) return ['1'];
      if (['0', 'false', '错误', '错', '否', '×', '✗'].includes(v)) return ['0'];
      return null;
    }
    if (values.some(v => !/^[A-E\s,，、;；|/]+$/.test(String(v).normalize('NFKC').toUpperCase().trim()))) return null;
    return [...new Set(values.flatMap(v => String(v).normalize('NFKC').toUpperCase().match(/[A-E]/g) || []))].sort();
  } catch { return null; }
}
export function validateBank(bank) {
  if (!object(bank) || bank.schema_version !== 1 || bank.format !== 'dhu-search-v1' || !Array.isArray(bank.questions)) throw new Error('bank_format');
  const ids = new Set();
  for (const q of bank.questions) {
    if (!object(q) || !text(q.id) || ids.has(q.id) || !text(q.question) || !kinds.includes(q.question_type) ||
      !Array.isArray(q.variants) || !q.variants.length || !Array.isArray(q.answer_texts) || !q.answer_texts.every(text)) throw new Error('question_format');
    ids.add(q.id);
    const keys = new Set(); let unverified = false;
    for (const v of q.variants) {
      if (!object(v) || v.question_type !== q.question_type || !text(v.question) || !object(v.options) ||
        !Object.values(v.options).every(text) || !Array.isArray(v.answer_labels) || !v.answer_labels.every(text) ||
        !Array.isArray(v.answer_texts) || !v.answer_texts.every(text) || !Array.isArray(v.sources) ||
        !['mapped', 'unverified'].includes(v.mapping_status)) throw new Error('variant_format');
      if (canonical(v.question) !== canonical(q.question)) throw new Error('stem_mismatch');
      if (v.mapping_status === 'mapped') {
        if (v.question_type === 'unknown' || !v.question.trim() || JSON.stringify(labelsFor(v.original_answer, v.question_type)) !== JSON.stringify(v.answer_labels)) throw new Error('original_mapping');
        if (!v.answer_labels.length || (v.question_type !== 'multi_choice' && v.answer_labels.length !== 1) ||
          v.answer_labels.some(label => !Object.hasOwn(v.options, label)) ||
          JSON.stringify(v.answer_labels.map(label => v.options[label])) !== JSON.stringify(v.answer_texts)) throw new Error('answer_mapping');
        if (v.question_type === 'judge' && (v.answer_labels.some(label => !['0', '1'].includes(label)) || v.options['1'] !== '正确' || v.options['0'] !== '错误')) throw new Error('judge_mapping');
        if (v.question_type !== 'judge' && (Object.keys(v.options).length < 2 || Object.keys(v.options).some(label => !/^[A-E]$/.test(label)) || v.answer_labels.some(label => !/^[A-E]$/.test(label)))) throw new Error('choice_mapping');
        keys.add(answerKey(v.answer_texts));
      } else { unverified = true; if (v.answer_texts.length || v.answer_labels.length) throw new Error('unverified_mapping'); }
      for (const source of v.sources) {
        if (!object(source) || !text(source.file) || !Number.isInteger(source.index) || !Array.isArray(source.contexts) ||
          !source.contexts.every(c => object(c) && [c.manual_id, c.chapter_id].every(id => id === null || text(id))) ||
          !Array.isArray(source.question_ids) || !source.question_ids.every(text) || !text(source.source) || !text(source.analysis) ||
          !Array.isArray(source.explanations) || !source.explanations.every(text)) throw new Error('source_format');
      }
    }
    const status = keys.size > 1 ? 'conflict' : unverified ? 'unverified' : 'verified';
    if (q.status !== status || q.has_unverified !== unverified ||
      (status === 'verified' ? !keys.has(answerKey(q.answer_texts)) : q.answer_texts.length !== 0)) throw new Error('answer_status');
  }
  return bank.questions;
}
