/* Local Chinese phrase + keyword + character-bigram retrieval. No network. */
const ignored = /[\s\p{P}\p{S}]/u;
export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
// Strip presentation metadata, not meaningful numbers within a question.
export function prepareQuery(query) {
  const type = '(?:单项选择题|多项选择题|单选题|多选题|判断题|单选|多选|判断)';
  const enclosed = new RegExp('(?:【\\s*' + type + '\\s*】|\\[\\s*' + type + '\\s*\\]|\\(\\s*' + type + '\\s*\\))', 'gu');
  const leadingType = new RegExp('^' + type + '(?:[：:]|\\s|$)\\s*', 'u');
  const ordinal = /^(?:第\s*[0-9一二三四五六七八九十百零〇]+\s*题\s*[.、:：]?|\([0-9一二三四五六七八九十百零〇]+\)\s*|(?:[0-9]{1,5}|[一二三四五六七八九十百零〇]{1,6})\s*(?:[、:：)]|\.(?![0-9]))\s*)/u;
  const lines = String(query ?? '').slice(0, 20000).normalize('NFKC').replace(/\r\n?/g, '\n').split('\n');
  const body = [];
  for (let line of lines) {
    line = line.replace(enclosed, ' ').trim();
    if (!body.length) {
      for (let i = 0; i < 3; i++) line = line.replace(ordinal, '').replace(leadingType, '').replace(/^\(\s*\d+(?:\.\d+)?\s*分\s*\)\s*/u, '').trim();
    }
    if (!line) continue;
    // Copied choices/answer notes are not part of the stem. Never use pasted answers as truth.
    if (body.length && /^(?:[A-E]\s*[.、:)\]]|(?:正确答案|参考答案|答案|解析)\s*[:：])/iu.test(line)) break;
    if (!body.length) line = line.replace(/^[A-E]\s*[.、:)\]]\s*/iu, '');
    const inline = line.search(/\s+[A-E]\s*[.、:)\]]\s*/u);
    if (inline > 0 && /[?？]/u.test(line.slice(0, inline))) { body.push(line.slice(0, inline)); break; }
    body.push(line);
  }
  return body.join(' ').trim();
}
export function termsFor(query) {
  return [...new Set(prepareQuery(query).toLowerCase().split(/[\s\p{P}\p{S}]+/u).map(normalize).filter(Boolean))].slice(0, 128);
}
function grams(text) {
  const chars = [...text];
  return [...new Set(chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]))];
}
function sampled(values, limit = 128) {
  if (values.length <= limit) return values;
  return Array.from({ length: limit }, (_, i) => values[Math.floor(i * (values.length - 1) / (limit - 1))]);
}
export function buildIndex(questions) {
  const postings = new Map();
  const documents = questions.map((question, position) => {
    const fields = [question.question, ...question.variants.flatMap(v => [v.question, ...Object.values(v.options)])].map(normalize);
    const stemFields = [...new Set([question.question, ...question.variants.map(v => v.question)].map(normalize))];
    const allGrams = new Set(fields.flatMap(grams)), stemGrams = new Set(stemFields.flatMap(grams));
    for (const gram of allGrams) {
      if (!postings.has(gram)) postings.set(gram, new Set());
      postings.get(gram).add(position);
    }
    return { id: question.id, questionType: question.question_type, fields, stemFields, allGrams, stemGrams,
      optionFields: question.variants.flatMap(v => Object.values(v.options)).map(normalize) };
  });
  return { documents, postings };
}
export function filterResults(results, questionType, byId) {
  return questionType === 'all' ? results : results.filter(hit => byId.get(hit.id)?.question_type === questionType);
}
export function search(index, query, questionType = 'all') {
  if (!['all', 'one_choice', 'multi_choice', 'judge'].includes(questionType)) return [];
  const prepared = prepareQuery(query), terms = termsFor(query);
  if (!terms.length) return [];
  const evidence = terms.map(text => ({ text, parts: sampled(grams(text)) }));
  const phrase = normalize(prepared), phraseGrams = new Set(grams(phrase)), candidates = new Set();
  for (const { text, parts } of evidence) {
    if ([...text].length === 1) { index.documents.forEach((_, i) => candidates.add(i)); continue; }
    for (const gram of parts) for (const i of index.postings.get(gram) || []) candidates.add(i);
  }
  const results = [];
  for (const position of candidates) {
    const doc = index.documents[position];
    if (questionType !== 'all' && doc.questionType !== questionType) continue;
    let score = 0, matches = 0;
    for (const { text: term, parts } of evidence) {
      if (doc.stemFields.some(f => f.includes(term))) { score += 80 + Math.min(term.length, 200) * 3; matches++; continue; }
      if (doc.optionFields.some(f => f.includes(term))) { score += 24 + Math.min(term.length, 200); matches++; continue; }
      const stemCount = parts.filter(p => doc.stemGrams.has(p)).length;
      const count = parts.filter(p => doc.allGrams.has(p)).length;
      if (parts.length >= 3 && count >= 2 && count / parts.length >= 0.6) {
        score += 25 * stemCount / parts.length + 8 * (count - stemCount) / parts.length; matches++;
      }
    }
    const exact = doc.stemFields.some(f => f === phrase);
    let similarity = 0;
    // Long pasted stems may contain small copying differences or line breaks. A strong
    // whole-stem match can succeed even when one punctuation-delimited token differs.
    if (!exact && phrase.length >= 16 && doc.stemFields.some(f => Math.min(f.length, phrase.length) / Math.max(f.length, phrase.length) >= 0.7)) {
      let overlap = 0;
      for (const g of doc.stemGrams) if (phraseGrams.has(g)) overlap++;
      similarity = 2 * overlap / (phraseGrams.size + doc.stemGrams.size);
    }
    if (matches !== terms.length && !exact && similarity < 0.82) continue;
    if (doc.stemFields.some(f => f.includes(phrase))) score += phrase.length >= 16 ? 12000 : 140;
    else if (doc.optionFields.some(f => f.includes(phrase))) score += 35;
    if (exact) score += 100000;
    else if (similarity >= 0.82) score += 6000 + similarity * 1000;
    score += matches * matches * 20;
    results.push({ id: doc.id, score });
  }
  return results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}
export function highlightRanges(text, query) {
  text = String(text);
  let normalized = '', offset = 0;
  const positions = [];
  for (const char of text) {
    const piece = char.normalize('NFKC').toLowerCase();
    for (const p of piece) if (!ignored.test(p)) {
      normalized += p;
      for (let i = 0; i < p.length; i++) positions.push([offset, offset + char.length]);
    }
    offset += char.length;
  }
  const ranges = [];
  function add(term) {
    let start = 0;
    while (term && (start = normalized.indexOf(term, start)) !== -1) {
      ranges.push([positions[start][0], positions[start + term.length - 1][1]]);
      start += Math.max(term.length, 1);
    }
  }
  for (const term of termsFor(query)) {
    if (normalized.includes(term)) add(term);
    else { const parts = sampled(grams(term)); if (parts.length >= 3) parts.forEach(add); }
  }
  ranges.sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const range of ranges) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}
