import { buildIndex, search } from './search.js';
let index;
self.onmessage = event => {
  const m = event.data;
  try {
    if (m.kind === 'init') { index = buildIndex(m.questions); self.postMessage({ kind: 'ready' }); }
    if (m.kind === 'search' && index) self.postMessage({ kind: 'results', seq: m.seq, results: search(index, m.query, m.questionType) });
  } catch { self.postMessage({ kind: 'error' }); }
};
