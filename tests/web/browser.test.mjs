import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBrowser, delay, waitFor } from './browser-helper.mjs';
const web = fileURLToPath(new URL('../../web/', import.meta.url));
const executable = process.env.CHROMIUM_BIN || 'chromium';
const available = spawnSync(executable, ['--version']).status === 0;
const row = updates => ({ question_type: 'one_choice', question: '学生因病无法参加期末考试，应办理什么手续？', A: '办理缓考手续', B: '直接缺考', answer: 'A', ...updates });
function convert(rows) {
  const result = spawnSync('python3', ['-c', 'import json,sys;from tools.build_search_bank import build_documents;print(json.dumps(build_documents([("synthetic-fixture-not-for-publication.json",json.load(sys.stdin))]),ensure_ascii=False))'], { input: JSON.stringify(rows), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
const fixture = convert([row(), row({ A: '直接缺考', B: '办理缓考手续', answer: 'B' }),
  row({ question_type: 'multi_choice', question: '学生申请缓考需要符合哪些条件？', A: '符合申请条件', B: '按时完成申请', C: '无须审批', answer: 'AB' }),
  row({ question_type: 'multi_choice', question: '学生申请缓考需要符合哪些条件？', A: '符合申请条件', B: '按时完成申请', C: '无须审批', answer: 'AC' }),
  row({question_type:'multi_choice',question:'奖学金申请需要提供哪些材料？',A:'成绩单',B:'申请表',C:'无需材料',answer:'AB'}),
  { question_type: 'judge', question: '学生应当遵守考试纪律。', answer: '0' },
  row({ question: '学生申请学籍证明应向哪个部门提交？', answer: 'E' }),
  row({ question: '<img src=x onerror=evil()>学生信息安全', A: '<script>evil()</script>' }),
  ...Array.from({ length: 80 }, (_, i) => row({ question: `校园通行测试专用问题第 ${i} 条` }))]);

test('real Chromium static site: data, search, modal, pagination, mobile and subpath', { skip: !available ? 'Chromium unavailable; static-browser checks not executed' : false, timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'dhu-search-browser-'));
  let mode = 'fixture', browser; const requests = [], exceptions = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost'); requests.push(url.pathname);
    try {
      const prefix = '/-dhu-question-search/';
      if (!url.pathname.startsWith(prefix)) { res.writeHead(404); res.end(); return; }
      let asset = url.pathname.slice(prefix.length) || 'index.html';
      if (!/^[a-z0-9.\-]+$/i.test(asset)) { res.writeHead(404); res.end(); return; }
      let body;
      if (asset === 'question-bank.json') {
        if (mode === 'fixture') body = JSON.stringify(fixture);
        else if (mode === 'corrupt') { const bad = structuredClone(fixture); bad.questions.find(q => q.status === 'verified').answer_texts = ['错误篡改']; body = JSON.stringify(bad); }
        else body = JSON.stringify(convert([]));
      } else body = await readFile(join(web, asset));
      res.writeHead(200, { 'content-type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' }[extname(asset)] || 'text/plain') + '; charset=utf-8', 'cache-control': 'no-store' }); res.end(body);
    } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const site = `http://127.0.0.1:${server.address().port}/-dhu-question-search/`;
  try {
    browser = await startBrowser(directory);
    browser.listeners.push(m => { if (m.method === 'Runtime.exceptionThrown') exceptions.push(m.params); });
    const ev = expression => browser.evaluate(expression);
    const key = async (value, code, keyCode, modifiers = 0) => {
      await browser.call('Page.bringToFront');
      await browser.call('Input.dispatchKeyEvent', { type: 'keyDown', key: value, code, windowsVirtualKeyCode: keyCode, modifiers, ...(value==='Enter'?{text:'\r',unmodifiedText:'\r'}:{}) });
      await browser.call('Input.dispatchKeyEvent', { type: 'keyUp', key: value, code, windowsVirtualKeyCode: keyCode, modifiers: 0 });
    };
    const ready = () => waitFor(() => ev("document.querySelector('#bank-count')?.textContent.startsWith('已收录')"), 'bank ready');
    const navigate = async () => { await browser.call('Page.navigate', { url: site }); await ready(); };
    const query = async text => {
      await ev(`document.querySelector('#query').value=${JSON.stringify(text)};document.querySelector('#query').dispatchEvent(new Event('input',{bubbles:true}));`);
      await waitFor(() => ev("document.querySelector('#search-area').getAttribute('aria-busy')==='false' && !document.querySelector('#result-heading').hidden"), 'query ' + text);
      await delay(140); // Debounce must have completed even if prior query was already idle.
      await waitFor(() => ev("document.querySelector('#search-area').getAttribute('aria-busy')==='false'"), 'results settled');
    };
    const screenshot = async name => { const { data } = await browser.call('Page.captureScreenshot', { format: 'png' }); await writeFile(join(tmpdir(), name), Buffer.from(data, 'base64')); };
    await browser.call('Emulation.setDeviceMetricsOverride', { width: 1200, height: 900, deviceScaleFactor: 1, mobile: false });
    await navigate();
    await t.test('first notice is unchecked, modal/inert, keyboard accessible, and restores focus', async () => {
      assert.equal(await ev("document.querySelector('#notice').open"), true);
      assert.equal(await ev("document.querySelector('#remember').checked"), false);
      assert.equal(await ev("document.activeElement.id"), 'notice-title');
      await ev("document.querySelector('#query').focus()"); assert.equal(await ev("document.querySelector('#notice').contains(document.activeElement)"), true);
      await key('Tab', 'Tab', 9, 8);
      assert.equal(await ev('document.activeElement.id'), 'understand');
      await screenshot('dhu-search-notice.png');
      await key('Enter', 'Enter', 13);
      await waitFor(() => ev('document.activeElement.id === "query"'), 'restored search focus');
    });
    await t.test('Chinese search maps full answer, highlights text and preserves reordered versions', async () => {
      await query('因病 期末考试');
      assert.equal(await ev("document.querySelectorAll('.result').length"), 1);
      assert.equal(await ev("document.querySelector('.answer-list .answer-text').textContent"), '办理缓考手续');
      assert.ok(await ev("document.querySelectorAll('.result mark').length") >= 2);
      await ev("document.querySelector('summary').click()"); await waitFor(() => ev("document.querySelectorAll('.variant').length===2"), 'lazy versions');
      assert.equal(await ev("document.querySelector('.result').textContent.includes('本版本答案：A') && document.querySelector('.result').textContent.includes('本版本答案：B')"), true);
      await screenshot('dhu-search-desktop.png');
    });
    await t.test('conflict, uncertainty and judge rendering never invent a definite answer', async () => {
      await query('缓考 条件');
      assert.equal(await ev("document.querySelector('.result').dataset.status"), 'conflict');
      assert.equal(await ev("document.querySelector('.result').textContent.includes('答案存在冲突，请核实')"), true);
      assert.equal(await ev("[...document.querySelectorAll('.answer-label')].some(n=>n.textContent==='正确答案')"), false);
      assert.equal(await ev("document.querySelectorAll('.candidate').length"), 2);
      await query('学籍证明'); assert.equal(await ev("document.querySelector('.result').dataset.status"), 'unverified');
      assert.equal(await ev("document.querySelectorAll('.result .answer-list').length"), 0);
      await query('考试纪律'); assert.equal(await ev("document.querySelector('.answer-list').textContent"), '错误');
      await query('奖学金 材料'); assert.deepEqual(await ev("[...document.querySelectorAll('.answer-list .answer-text')].map(n=>n.textContent)"), ['成绩单','申请表']);
    });
    await t.test('verified answer panel uses one saved version for both letters and full text', async () => {
      await query('因病 期末考试');
      const variant=fixture.questions.find(q=>q.question.includes('因病')).variants[0];
      assert.equal(await ev("document.querySelector('.answer-panel .answer-label').textContent"),'正确答案：'+variant.answer_labels.join('、'));
      assert.deepEqual(await ev("[...document.querySelectorAll('.answer-panel .answer-letter')].map(n=>n.textContent)"),variant.answer_labels.map(l=>l+'.'));
      assert.deepEqual(await ev("[...document.querySelectorAll('.answer-panel .answer-text')].map(n=>n.textContent)"),variant.answer_labels.map(l=>variant.options[l]));
      assert.equal(await ev("document.querySelector('.type-tag').classList.contains('type-one_choice')"),true);
      assert.ok(await ev("parseInt(getComputedStyle(document.querySelector('.answer-panel .answer-list')).fontWeight)")>=600);
      assert.equal(await ev("getComputedStyle(document.querySelector('.answer-panel')).backgroundColor"),'rgb(232, 241, 233)');
      await query('缓考 条件'); assert.equal(await ev("document.querySelector('.answer-panel')===null"),true);
      assert.equal(await ev("!!document.querySelector('.warning-panel')"),true);
      await query('学籍证明'); assert.equal(await ev("document.querySelector('.answer-panel')===null"),true);
      await query('奖学金 材料'); assert.equal(await ev("document.querySelectorAll('.answer-panel li').length"),2);
      assert.equal(await ev("document.querySelector('.type-tag').classList.contains('type-multi_choice')"),true);
      await query('考试纪律'); assert.equal(await ev("document.querySelector('.answer-panel .answer-list').textContent"),'错误');
      assert.equal(await ev("document.querySelectorAll('.answer-letter').length"),0);
      assert.equal(await ev("document.querySelector('.type-tag').classList.contains('type-judge')"),true);
    });
    await t.test('native multiline paste auto-searches and keeps textarea height bounded', async () => {
      await ev("document.querySelector('#query').value='';document.querySelector('#query').focus()");
      await browser.call('Input.insertText',{text:'12.【单选题】\n学生因病无法参加期末考试，\n应办理什么手续？\nA. 这是复制时的选项，不作为答案依据\nB. 不同文字'});
      await waitFor(()=>ev("document.querySelector('.answer-panel .answer-text')?.textContent==='办理缓考手续'"),'native pasted stem');
      assert.equal(await ev("document.querySelector('#query').tagName"),'TEXTAREA');
      assert.equal(await ev("document.querySelector('#query').placeholder"),'粘贴题目，或输入几个关键词');
      assert.equal(await ev("document.querySelector('#query').value.includes('\\n')"),true);
      assert.ok(await ev("document.querySelector('#query').getBoundingClientRect().height")<=144);
      assert.ok(await ev("document.querySelectorAll('.result mark').length")>0);
    });
    await t.test('filters retain query, combine with ranking, reset pagination, and resist stale worker replies', async () => {
      await query('学生');const text=await ev("document.querySelector('#query').value");
      for(const type of ['one_choice','multi_choice','judge']) {
        await ev(`document.querySelector('[data-type="${type}"]').click()`);
        await waitFor(()=>ev(`document.querySelector('#search-area').getAttribute('aria-busy')==='false' && document.querySelector('[data-type="${type}"]').getAttribute('aria-pressed')==='true' && [...document.querySelectorAll('.result .type-tag')].every(n=>n.classList.contains('type-${type}'))`),'type filter '+type);
        await delay(140);
        assert.equal(await ev("document.querySelector('#query').value"),text);
        assert.ok(await ev("document.querySelectorAll('.result').length")>0);
      }
      await ev("document.querySelector('[data-type=one_choice]').click();document.querySelector('[data-type=judge]').click();document.querySelector('[data-type=multi_choice]').click()");
      await delay(220);assert.equal(await ev("[...document.querySelectorAll('.result .type-tag')].every(n=>n.classList.contains('type-multi_choice'))"),true);
      await ev("document.querySelector('[data-type=all]').click()");await delay(200);
      assert.equal(await ev("document.querySelector('#query').value"),text);
    });
    await t.test('untrusted text remains plain text without creating HTML', async () => {
      await query('信息安全');
      assert.equal(await ev("document.querySelector('.result h3 img')===null"), true);
      assert.equal(await ev("document.querySelector('.result h3').textContent.includes('<img')"), true);
      assert.equal(await ev("typeof window.evil"), 'undefined');
    });
    await t.test('many results render 25 at a time, with clear and no-result states', async () => {
      await query('校园通行'); assert.equal(await ev("document.querySelectorAll('.result').length"), 25);
      await ev("document.querySelector('#more').click()"); assert.equal(await ev("document.querySelectorAll('.result').length"), 50);
      assert.equal(await ev("document.activeElement === document.querySelectorAll('.result')[25]"), true);
      await query('不存在的火星飞船'); assert.equal(await ev("document.querySelectorAll('.result').length"), 0);
      assert.equal(await ev("document.querySelector('#empty-title').textContent"), '暂未找到相关题目');
      await ev("document.querySelector('#clear').click()"); await delay(180);
      assert.equal(await ev("document.querySelector('#result-heading').hidden"), true);
    });
    await t.test('Chinese input composition waits for completion and cannot show stale answers', async () => {
      await query('校园通行');
      await ev("const input=document.querySelector('#query');input.dispatchEvent(new CompositionEvent('compositionstart'));input.value='因病';input.dispatchEvent(new InputEvent('input',{bubbles:true,isComposing:true}));");
      await delay(200); assert.equal(await ev("document.querySelectorAll('.result').length"), 0);
      await ev("document.querySelector('#query').dispatchEvent(new CompositionEvent('compositionend'))");
      await waitFor(() => ev("document.querySelectorAll('.result').length===1"), 'IME search completes');
    });
    await t.test('notice opt-out persists; manual reopen and Escape do not unexpectedly change preference', async () => {
      await navigate(); assert.equal(await ev("document.querySelector('#notice').open"), true);
      await ev("document.querySelector('#remember').checked=true;document.querySelector('#understand').click()");
      await navigate(); assert.equal(await ev("document.querySelector('#notice').open"), false);
      await ev("document.querySelector('#help').click()"); assert.equal(await ev("document.querySelector('#remember').checked"), true);
      await key('Escape', 'Escape', 27);
      await waitFor(() => ev("!document.querySelector('#notice').open"), 'Escape closes notice');
      await waitFor(() => ev("document.activeElement.id==='help'"), 'restored help focus');
      assert.equal(await ev("localStorage.getItem('dhu-search-notice-dismissed-v1')"), '1');
      await ev("document.querySelector('#help').click();document.querySelector('#understand').click()");
      assert.equal(await ev("localStorage.getItem('dhu-search-notice-dismissed-v1')"), '1');
    });
    await t.test('mobile layout and short-screen dialog fit without horizontal overflow', async () => {
      await browser.call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
      await query('因病 期末考试');
      assert.equal(await ev('document.documentElement.scrollWidth <= window.innerWidth'), true);
      assert.ok(await ev("parseFloat(getComputedStyle(document.querySelector('#query')).fontSize)") >= 16);
      assert.equal(await ev("[...document.querySelectorAll('.type-filters button')].every(b=>b.getBoundingClientRect().height>=44)"),true);
      assert.equal(await ev("!!document.querySelector('.answer-panel')"),true);
      await screenshot('dhu-search-mobile.png');
      await browser.call('Emulation.setDeviceMetricsOverride', { width: 320, height: 480, deviceScaleFactor: 1, mobile: true });
      await ev("document.querySelector('#help').click()");
      assert.equal(await ev("(()=>{const r=document.querySelector('#notice').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight;})()"), true);
      assert.equal(await ev("document.querySelector('.notice-body').scrollHeight > document.querySelector('.notice-body').clientHeight"), true);
      await ev("document.querySelector('#understand').click()");
    });
    await t.test('blocked localStorage and unavailable Worker still allow search', async () => {
      const { identifier } = await browser.call('Page.addScriptToEvaluateOnNewDocument', { source: "Object.defineProperty(window,'localStorage',{get(){throw new Error('blocked')}});window.Worker=undefined;" });
      await navigate(); assert.equal(await ev("document.querySelector('#notice').open"), true);
      await ev("document.querySelector('#remember').checked=true;document.querySelector('#understand').click()");
      await query('无法参加考试'); assert.equal(await ev("document.querySelectorAll('.result').length"), 1);
      await browser.call('Page.removeScriptToEvaluateOnNewDocument', { identifier });
    });
    await t.test('empty production bank is usable; damaged answers fail closed and can retry', async () => {
      mode = 'empty'; await navigate();
      assert.equal(await ev("document.querySelector('#bank-count').textContent"), '已收录 0 道题目');
      await query('考试'); assert.equal(await ev("document.querySelectorAll('.result').length"), 0);
      mode = 'corrupt'; await browser.call('Page.navigate', { url: site });
      await waitFor(() => ev("document.querySelector('#empty-title')?.textContent==='题库未能加载'"), 'damaged bank detected');
      assert.equal(await ev("document.querySelector('#query').disabled"), true);
      mode = 'empty'; await ev("document.querySelector('#retry').click()"); await ready();
    });
    await t.test('all assets and worker load beneath the GitHub Pages subpath without external services', async () => {
      assert.ok(requests.some(p => p.endsWith('/search-worker.js')));
      assert.ok(requests.some(p => p.endsWith('/question-bank.json')));
      assert.ok(requests.every(p => p.startsWith('/-dhu-question-search/')), JSON.stringify(requests));
      assert.deepEqual(exceptions, []);
    });
  } finally {
    if (browser) await browser.stop(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true });
  }
});
