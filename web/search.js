/* Local Chinese phrase + keyword + character-bigram retrieval. No network. */
const ignored = /[\s\p{P}\p{S}]/u;
export function normalize(value) {
  return String(value ?? '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}
export function termsFor(query) {
  return [...new Set(String(query).slice(0, 200).normalize('NFKC').toLowerCase()
    .split(/[\s\p{P}\p{S}]+/u).map(normalize).filter(Boolean))];
}
function grams(text) {
  const chars = [...text];
  return [...new Set(chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]))];
}
export function buildIndex(questions) {
  const postings = new Map();
  const documents = questions.map((question, position) => {
    // Separators must not create artificial bigrams between different option texts.
    const fields = [question.question, ...question.variants.flatMap(v => [v.question, ...Object.values(v.options)])].map(normalize);
    for (const gram of new Set(fields.flatMap(grams))) {
      if (!postings.has(gram)) postings.set(gram, new Set());
      postings.get(gram).add(position);
    }
    return { id: question.id, fields, stemFields: [question.question, ...question.variants.map(v => v.question)].map(normalize),
      optionFields: question.variants.flatMap(v => Object.values(v.options)).map(normalize) };
  });
  return { documents, postings };
}
export function search(index, query) {
  const terms = termsFor(query);
  if (!terms.length) return [];
  const candidates = new Set();
  for (const term of terms) {
    // One-character queries are uncommon; scan fields without bloating the index.
    if ([...term].length === 1) { index.documents.forEach((_, i) => candidates.add(i)); continue; }
    for (const gram of grams(term)) for (const i of index.postings.get(gram) || []) candidates.add(i);
  }
  const phrase = normalize(query.slice(0, 200)), results = [];
  for (const position of candidates) {
    const doc = index.documents[position];
    let score = 0, matches = 0;
    for (const term of terms) {
      if (doc.stemFields.some(f => f.includes(term))) { score += 80 + term.length * 3; matches++; continue; }
      if (doc.optionFields.some(f => f.includes(term))) { score += 24 + term.length; matches++; continue; }
      const parts = grams(term);
      const stemCount = parts.filter(p => doc.stemFields.some(f => f.includes(p))).length;
      const count = parts.filter(p => doc.fields.some(f => f.includes(p))).length;
      // Gapped continuous phrases need substantial evidence, not a single shared character.
      const coverage = count / parts.length;
      if (parts.length >= 3 && count >= 2 && coverage >= 0.6) {
        score += 25 * stemCount / parts.length + 8 * (count - stemCount) / parts.length;
        matches++;
      }
    }
    if (matches !== terms.length) continue;
    if (doc.stemFields.some(f => f.includes(phrase))) score += 140;
    else if (doc.optionFields.some(f => f.includes(phrase))) score += 35;
    if (doc.stemFields.some(f => f === phrase)) score += 180;
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
    else if (grams(term).length >= 3) grams(term).forEach(add);
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
