import { buildIndex, search, normalize, prepareQuery, filterResults, highlightRanges } from './search.js';
import { validateBank } from './bank.js';
import { setupNotice } from './notice.js';
const $ = id => document.getElementById(id);
const input = $('query'), resultsNode = $('results');
const BATCH = 25, types = { one_choice: '单选题', multi_choice: '多选题', judge: '判断题', unknown: '题型待核实' };
const reasons = { invalid_type: '题型无法识别', missing_question: '题干缺失', invalid_options: '选项格式无效或内容冲突',
  missing_options: '选项不足', invalid_answer: '答案缺失或无法可靠映射', ambiguous_judge: '判断题字母选项含义不明确' };
let activeType = 'all';
let questions = [], byId = new Map(), index, worker, ready = false, workerReady = false, hits = [], shown = 0, seq = 0, timer, composing = false, workerWatchdog;
function node(tag, className, text) {
  const element = document.createElement(tag); if (className) element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
function highlighted(tag, className, text) {
  const element = node(tag, className); let from = 0;
  for (const [start, end] of highlightRanges(text, input.value)) {
    element.append(document.createTextNode(text.slice(from, start)), node('mark', '', text.slice(start, end))); from = end;
  }
  element.append(document.createTextNode(text.slice(from))); return element;
}
function answerList(texts, labels = []) {
  const list = node('ul', 'answer-list');
  texts.forEach((text, i) => {
    const item = node('li');
    if (labels[i]) item.append(node('span', 'answer-letter', labels[i] + '.'));
    item.append(highlighted('span', 'answer-text', text)); list.append(item);
  });
  return list;
}
function answerPanel(q) {
  // The label and text always come from ONE validated saved version, never from
  // independently sorted text or an assumption about the platform's current order.
  const i = q.variants.findIndex(v => v.mapping_status === 'mapped'), v = q.variants[i];
  const panel = node('section', 'answer-panel'); panel.dataset.version = String(i + 1);
  const labels = q.question_type === 'judge' ? [] : v.answer_labels;
  panel.append(node('p', 'answer-label', '正确答案' + (labels.length ? '：' + labels.join('、') : '')),
    answerList(v.answer_labels.map(label => v.options[label]), labels));
  if (q.question_type !== 'judge' && q.variants.length > 1) panel.append(node('p', 'answer-note', `字母对应保存版本 ${i + 1}，请以选项文字为准。`));
  return panel;
}
function versionDetails(q) {
  const details = node('details'), summary = node('summary', '', `选项与来源 · ${q.variants.length} 个保存版本`); details.append(summary);
  // Version DOM is lazy too: the initial result list stays small even with many observations.
  details.addEventListener('toggle', () => {
    if (!details.open || details.dataset.rendered) return; details.dataset.rendered = '1';
    q.variants.forEach((v, i) => {
      const block = node('section', 'variant'); block.append(node('p', 'version-title', `保存版本 ${i + 1}`));
      const options = node('ul', 'options-list');
      for (const [label, value] of Object.entries(v.options)) {
        const item = node('li'); item.append(node('span', 'option-label', label), highlighted('span', 'option-value', value)); options.append(item);
      }
      block.append(options);
      if (v.mapping_status === 'mapped') block.append(node('p', '', `本版本答案：${v.answer_labels.join('、')}（${v.answer_texts.join('；')}）`));
      else {
        block.append(node('p', 'warning', `答案待核实：${reasons[v.reason] || '无法可靠映射'}`));
        const raw = v.original_answer == null ? '未提供' : Array.isArray(v.original_answer) ? v.original_answer.join('、') : String(v.original_answer);
        block.append(node('p', '', '原记录答案：' + raw));
        // Preserve contradictory option forms without selecting one as authoritative.
        if (v.option_input != null) block.append(node('p', 'source', '原 options 字段：' + JSON.stringify(v.option_input)));
        if (v.option_fields && Object.keys(v.option_fields).length) block.append(node('p', 'source', '原字母字段：' + JSON.stringify(v.option_fields)));
      }
      v.sources.forEach(s => {
        const contexts = s.contexts.map(c => `手册 ${c.manual_id || '未知'} / 章节 ${c.chapter_id || '未知'}`);
        block.append(node('p', 'source', [s.file, `记录 ${s.index + 1}`, ...contexts, s.question_ids.length ? `题目 ID ${s.question_ids.join('、')}` : ''].filter(Boolean).join(' · ')));
        for (const text of new Set([s.source, s.analysis, ...s.explanations].filter(Boolean))) block.append(node('p', 'source', text));
      });
      details.append(block);
    });
  });
  return details;
}
function renderQuestion(q) {
  const article = node('article', 'result'); article.dataset.status = q.status;
  const meta = node('div', 'result-meta'); meta.append(node('span', 'type-tag type-' + q.question_type, types[q.question_type]));
  if (q.status !== 'verified') meta.append(node('span', 'warning', q.status === 'conflict' ? '答案存在冲突' : '答案待核实'));
  article.append(meta, highlighted('h3', '', q.question || '题干缺失，数据待核实'));
  if (q.status === 'verified') article.append(answerPanel(q));
  else {
    const warning = node('section', 'warning-panel');
    warning.append(node('p', 'warning', q.status === 'conflict' ? '答案存在冲突，请核实' : '答案待核实，请核对原始记录'));
    warning.append(node('p', 'warning-detail', q.status === 'conflict' ? '不同记录给出了不同答案，尚不能确定哪一版正确。' : '部分记录无法可靠映射答案，以下内容不能视为确定答案。'));
    const seen = new Set();
    for (const v of q.variants) if (v.mapping_status === 'mapped') {
      const key = JSON.stringify([...new Set(v.answer_texts)].sort()); if (seen.has(key)) continue; seen.add(key);
      const candidate = node('div', 'candidate'); candidate.append(node('p', 'answer-label', `已记录的候选答案 ${seen.size}`), answerList(v.answer_texts)); warning.append(candidate);
    }
    if (q.status === 'conflict' && q.has_unverified) warning.append(node('p', 'warning-detail', '另有答案待核实的记录，请一并查看保存版本。'));
    article.append(warning);
  }
  article.append(versionDetails(q)); return article;
}
function empty(title, description, show = true) {
  $('empty-title').textContent = title; $('empty-description').textContent = description; $('empty').hidden = !show;
}
function renderMore() {
  const fragment = document.createDocumentFragment(), first = shown;
  for (const hit of hits.slice(shown, shown + BATCH)) fragment.append(renderQuestion(byId.get(hit.id)));
  shown = Math.min(hits.length, shown + BATCH); resultsNode.append(fragment);
  $('more').hidden = shown >= hits.length;
  $('result-count').textContent = `找到 ${hits.length.toLocaleString('zh-CN')} 道 · 已显示 ${shown.toLocaleString('zh-CN')} 道`;
  if (first > 0) { const next = resultsNode.children[first]; next.tabIndex = -1; next.focus({ preventScroll: true }); }
}
function receive(results, resultSeq) {
  if (resultSeq !== seq) return; clearTimeout(workerWatchdog); hits = filterResults(results, activeType, byId); shown = 0; resultsNode.replaceChildren();
  $('search-area').setAttribute('aria-busy', 'false');
  $('result-heading').hidden = !normalize(prepareQuery(input.value));
  if (!normalize(prepareQuery(input.value))) { $('more').hidden = true; empty(questions.length ? '从几个关键词开始' : '题库正在整理', questions.length ? '无需输入完整题目，也可以检索选项中的文字。' : '目前尚未收录题目，数据更新后即可检索。'); return; }
  empty('暂未找到相关题目', questions.length ? '试试减少关键词，或换一段题干文字。未找到不代表题目不存在。' : '目前题库为空，尚没有可检索的题目。', !hits.length);
  renderMore();
}
function fallback() {
  worker?.terminate(); worker = null; workerReady = false; clearTimeout(workerWatchdog);
  // A worker/CSP failure still permits local search with the same retrieval algorithm.
  if (ready) { index ||= buildIndex(questions); receive(search(index, input.value, activeType), seq); }
}
function runSearch() {
  if (!ready || composing) return;
  $('search-area').setAttribute('aria-busy', 'true'); const current = seq;
  if (worker && !workerReady) { empty('正在准备检索', '题库已读取，正在建立本地索引。'); return; }
  if (workerReady) {
    worker.postMessage({ kind: 'search', seq: current, query: input.value, questionType: activeType });
    clearTimeout(workerWatchdog); workerWatchdog = setTimeout(fallback, 5000);
  } else { index ||= buildIndex(questions); receive(search(index, input.value, activeType), current); }
}
function fitInput() {
  input.style.height = 'auto';
  input.style.height = Math.max(56, Math.min(input.scrollHeight, 144)) + 'px';
  input.style.overflowY = input.scrollHeight > 144 ? 'auto' : 'hidden';
}
function changed() {
  seq++; clearTimeout(timer); $('clear').hidden = !input.value; fitInput();
  // Never leave answers for the previous query under the current input.
  resultsNode.replaceChildren(); $('more').hidden = true; $('result-heading').hidden = true; $('empty').hidden = true;
  if (!composing) timer = setTimeout(runSearch, 110);
}
input.addEventListener('input', changed);
input.addEventListener('compositionstart', () => { composing = true; seq++; clearTimeout(timer); });
input.addEventListener('compositionend', () => { composing = false; changed(); });
input.addEventListener('keydown', event => { if (event.key === 'Escape' && input.value) { input.value = ''; changed(); } });
$('clear').addEventListener('click', () => { input.value = ''; changed(); input.focus(); });
$('more').addEventListener('click', renderMore);
for (const button of document.querySelectorAll('.type-filters button')) {
  button.addEventListener('click', () => {
    if (activeType === button.dataset.type) return;
    activeType = button.dataset.type;
    for (const option of document.querySelectorAll('.type-filters button')) option.setAttribute('aria-pressed', String(option === button));
    changed();
  });
}
window.addEventListener('resize', fitInput);
async function load() {
  ready = false; input.disabled = true; $('retry').hidden = true;
  empty('正在读取题库', '请稍候。'); $('bank-count').textContent = '正在读取题库…';
  try {
    const response = await fetch(new URL('./question-bank.json', import.meta.url), { cache: 'no-cache' });
    if (!response.ok) throw new Error('load_failed');
    questions = validateBank(await response.json()); byId = new Map(questions.map(q => [q.id, q]));
    $('bank-count').textContent = `已收录 ${questions.length.toLocaleString('zh-CN')} 道题目`;
    ready = true; input.disabled = false; index = null; fitInput();
    if (typeof Worker !== 'undefined') {
      try {
        worker = new Worker(new URL('./search-worker.js', import.meta.url), { type: 'module' });
        worker.onmessage = event => {
          const m = event.data;
          if (m.kind === 'ready') { workerReady = true; clearTimeout(workerWatchdog); runSearch(); }
          else if (m.kind === 'results') receive(m.results, m.seq);
          else if (m.kind === 'error') fallback();
        };
        worker.onerror = fallback; worker.postMessage({ kind: 'init', questions });
        workerWatchdog = setTimeout(fallback, 5000);
      } catch { fallback(); }
    }
    runSearch();
  } catch {
    $('bank-count').textContent = '题库暂时无法读取'; $('search-area').setAttribute('aria-busy', 'false');
    empty('题库未能加载', '请稍后重试。若持续失败，请检查题库文件是否已经正确发布。'); $('retry').hidden = false;
  }
}
$('retry').addEventListener('click', load);
setupNotice({ dialog: $('notice'), help: $('help'), confirm: $('understand'), remember: $('remember'), title: $('notice-title'), searchInput: input, storage: () => localStorage });
void load();
