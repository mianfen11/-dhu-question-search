/* Shared by the isolated bridge, page observer and extension worker. No network. */
(() => {
  'use strict';
  const TYPES = Object.freeze(['one_choice', 'multi_choice', 'judge']);
  const PREFIX = '/api/protected/app/manual/chapter/questions/';
  const MARKER = 'dhu-question-bank/v1';
  const MAX_ROWS = 100, MAX_TEXT = 50000, MAX_MESSAGE = 1000000;
  const aliases = {'单选':'one_choice','单选题':'one_choice',single:'one_choice',
    '多选':'multi_choice','多选题':'multi_choice',multiple:'multi_choice',
    '判断':'judge','判断题':'judge',boolean:'judge'};
  const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
  const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
  const first = (o, ...keys) => { for (const k of keys) if (own(o,k) && o[k] != null) return o[k]; return null; };
  function isPracticePage(href) {
    try {
      const u = new URL(href);
      if (u.origin !== 'https://aidhu.net' || !u.pathname.startsWith('/web/')) return false;
      const [route, query = ''] = u.hash.slice(1).split('?');
      const p = new URLSearchParams(query);
      return route === '/main/handbookAnswer' && (!p.has('mode') || p.get('mode') === 'practice');
    } catch { return false; }
  }
  function endpoint(url, base) {
    try {
      const u = new URL(url, base);
      if (u.origin !== 'https://api.aidhu.net' || u.username || u.password || u.hash) return null;
      const type = TYPES.find(t => u.pathname === PREFIX + t);
      if (!type) return null;
      const ids = {};
      for (const k of ['manual_id','chapter_id']) {
        if (u.searchParams.getAll(k).length !== 1 || !/^[1-9]\d{0,15}$/.test(u.searchParams.get(k))) return null;
        ids[k] = u.searchParams.get(k);
      }
      // Do not carry a URL, query string, headers or request object across the bridge.
      return {path: PREFIX + type, question_type: type, ...ids};
    } catch { return null; }
  }
  function validMeta(m) {
    return object(m) && TYPES.includes(m.question_type) && m.path === PREFIX + m.question_type &&
      ['manual_id','chapter_id'].every(k => typeof m[k] === 'string' && /^[1-9]\d{0,15}$/.test(m[k])) &&
      Object.keys(m).sort().join(',') === 'chapter_id,manual_id,path,question_type';
  }
  function cleanMeta(m) {
    if (!validMeta(m)) throw new Error('接口元数据无效');
    return {path:m.path, question_type:m.question_type, manual_id:m.manual_id, chapter_id:m.chapter_id};
  }
  // Only permit explicitly known scalar fields. Never forward response/request objects.
  function filterRow(row, meta) {
    if (!object(row) || !validMeta(meta)) throw new Error('题目结构无效');
    const out = {question_type: meta.question_type, manual_id:meta.manual_id, chapter_id:meta.chapter_id};
    for (const k of ['question_type','manual_id','chapter_id']) {
      if (row[k] != null && String(row[k]) !== String(out[k])) throw new Error('题目与接口上下文冲突');
    }
    for (const k of ['question_id','question','A','B','C','D','E','answer','source','analysis','explanation']) {
      if (!own(row,k) || row[k] == null) continue;
      const value = row[k];
      if (k === 'answer' && Array.isArray(value)) {
        if (value.length > 5 || value.some(v => !['string','number','boolean'].includes(typeof v) || String(v).length > 100)) throw new Error('答案数组无效');
        out[k] = [...value];
      } else {
        if (!['string','number','boolean'].includes(typeof value) || (typeof value === 'number' && !Number.isFinite(value)) || String(value).length > MAX_TEXT) throw new Error('字段过长或类型无效');
        out[k] = value;
      }
    }
    if (typeof out.question !== 'string' || !out.question.trim()) throw new Error('题干为空');
    return out;
  }
  function bridgeMessage(data, href) {
    if (!isPracticePage(href) || !object(data) || data.marker !== MARKER || data.version !== 1 || !validMeta(data.meta) ||
        !Array.isArray(data.questions) || !data.questions.length || data.questions.length > MAX_ROWS) throw new Error('消息无效');
    if (Object.keys(data).sort().join(',') !== 'marker,meta,questions,version') throw new Error('消息包含未知字段');
    const safe = {marker:MARKER, version:1, meta:cleanMeta(data.meta), questions:data.questions.map(q => filterRow(q,data.meta))};
    if (JSON.stringify(safe).length > MAX_MESSAGE) throw new Error('消息过大');
    return safe;
  }
  const numericMap = {0:65533,128:8364,130:8218,131:402,132:8222,133:8230,134:8224,135:8225,136:710,137:8240,138:352,139:8249,140:338,142:381,145:8216,146:8217,147:8220,148:8221,149:8226,150:8211,151:8212,152:732,153:8482,154:353,155:8250,156:339,158:382,159:376};
  function unescapeHTML(s) {
    return s.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+);?|[^\t\n\f <&#;]{1,32};?)/g, (match, ref) => {
      if (ref[0] === '#') {
        let n = ref[1]?.toLowerCase() === 'x' ? parseInt(ref.slice(2),16) : parseInt(ref.slice(1),10);
        if (own(numericMap,n)) n = numericMap[n];
        if (n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) return '\ufffd';
        if ((n >= 1 && n <= 8) || n === 11 || (n >= 14 && n <= 31) || n === 127 || (n >= 0xfdd0 && n <= 0xfdef) || (n & 0xffff) >= 0xfffe) return '';
        return String.fromCodePoint(n);
      }
      for (let i=ref.length; i>0; i--) if (own(globalThis.DhuEntities,ref.slice(0,i))) return globalThis.DhuEntities[ref.slice(0,i)] + ref.slice(i);
      return match;
    });
  }
  function text(v) {
    if (v == null) return '';
    if (!['string','number'].includes(typeof v) || (typeof v === 'number' && !Number.isFinite(v))) throw new Error('文本字段无效');
    if (String(v).length > MAX_TEXT) throw new Error('文本字段过长');
    const result = unescapeHTML(String(v).normalize('NFC')).replace(/\r\n?/g,'\n').trim();
    if (/[\uD800-\uDFFF]/u.test(result)) throw new Error('无效 Unicode 字符');
    return result;
  }
  const id = v => v == null ? null : text(v) || null;
  function optionsFor(row) {
    const result = {};
    const add = (k,v) => {
      const label = text(k).normalize('NFKC').toUpperCase(), value = text(v);
      if (!/^[A-E]$/.test(label)) throw new Error('选项标签必须是 A～E');
      if (own(result,label) && result[label] !== value) throw new Error('选项内容冲突');
      result[label] = value;
    };
    if (row.options != null) {
      if (Array.isArray(row.options)) {
        row.options.forEach((o,i) => object(o) ? add(first(o,'key','label','id'),first(o,'value','text','content')) : add('ABCDE'[i],o));
        if (row.options.length > 5) throw new Error('选项超过 A～E');
      } else if (object(row.options)) Object.entries(row.options).forEach(([k,v]) => add(k,v));
      else throw new Error('options 必须是对象或数组');
    }
    for (const k of 'ABCDE') {
      const v = first(row,k,k.toLowerCase(),'option_'+k.toLowerCase());
      if (v != null && text(v)) add(k,v);
    }
    return Object.fromEntries(Object.entries(result).filter(([,v]) => v).sort());
  }
  function answerFor(value, kind, options) {
    if (typeof value === 'string' && value.trim().startsWith('[')) value = JSON.parse(value);
    const values = Array.isArray(value) ? value : [value];
    if (kind === 'judge') {
      if (values.length !== 1) throw new Error('判断题答案数量无效');
      if (typeof values[0] === 'boolean') return [values[0] ? '1':'0'];
      const v = text(values[0]).normalize('NFKC').toLowerCase();
      if (['1','true','正确','对','是','√','✓'].includes(v)) return ['1'];
      if (['0','false','错误','错','否','×','✗'].includes(v)) return ['0'];
      throw new Error('判断题答案不明确');
    }
    const answers = [];
    for (const v of values) {
      const s = text(v).normalize('NFKC').toUpperCase();
      if (!/^[A-E\s,，、;；|/]+$/.test(s)) throw new Error('选择题答案无效');
      answers.push(...s.match(/[A-E]/g) || []);
    }
    const out = [...new Set(answers)].sort();
    if (!out.length || (kind === 'one_choice' && out.length !== 1) || out.some(k => !own(options,k))) throw new Error('答案与选项不符');
    return out;
  }
  function normalize(row) {
    if (!object(row)) throw new Error('题目必须是对象');
    let kind = text(first(row,'question_type','type')); kind = aliases[kind] || kind;
    if (!TYPES.includes(kind)) throw new Error('未知题型');
    const question = text(first(row,'question','question_content','stem','title'));
    if (!question) throw new Error('题干为空');
    const canonicalJudge = kind === 'judge' && object(row.options) && Object.keys(row.options).length === 2 && row.options['1'] === '正确' && row.options['0'] === '错误';
    let options = optionsFor(canonicalJudge ? {...row,options:null} : row);
    if (kind === 'judge') {
      if (Object.keys(options).length) throw new Error('判断题带有不明确的字母选项');
      options = {'1':'正确','0':'错误'};
    } else if (Object.keys(options).length < 2) throw new Error('选项不足');
    return {question_id:id(first(row,'question_id','id')), manual_id:id(row.manual_id), chapter_id:id(row.chapter_id),
      question_type:kind, question, options, answer:answerFor(first(row,'answer','answers','correct_answer'),kind,options),
      explanation:text(first(row,'explanation','analysis','source'))};
  }
  function unpack(value, context={}, depth=0) {
    if (depth > 20) throw new Error('JSON 嵌套过深');
    if (Array.isArray(value)) return value.flatMap(v => unpack(v,context,depth+1));
    if (!object(value)) throw new Error('未知 JSON 结构');
    context = {...context};
    for (const k of ['manual_id','chapter_id','question_type']) if (value[k] != null) context[k]=value[k];
    if (['question','question_content','stem','title'].some(k => own(value,k))) return [{...context,...value}];
    if ((own(value,'code') && ![200,'200',0,'0'].includes(value.code)) || value.status === false) throw new Error('不是成功响应');
    for (const key of ['questions','items','data']) if (own(value,key)) return unpack(value[key],context,depth+1);
    const groups = TYPES.filter(t => own(value,t)).sort();
    if (groups.length) return groups.flatMap(t => unpack(value[t],{...context,question_type:t},depth+1));
    if (Array.isArray(value.chapters)) return value.chapters.flatMap(c => unpack(c,context,depth+1));
    throw new Error('未知 JSON 封装');
  }
  // Match Python json.dumps(..., ensure_ascii=False, sort_keys=True) for record_id.
  function stable(value) {
    if (Array.isArray(value)) return '['+value.map(stable).join(', ')+']';
    if (object(value)) return '{'+Object.keys(value).sort().map(k => JSON.stringify(k)+': '+stable(value[k])).join(', ')+'}';
    return JSON.stringify(value);
  }
  function content(q, withAnswer=true) {
    const out = {};
    for (const k of ['manual_id','chapter_id','question_type','question','options',...(withAnswer?['answer']:[])]) out[k] = q[k];
    return out;
  }
  async function fingerprint(q) {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stable(content(q))));
    return [...new Uint8Array(bytes)].map(x => x.toString(16).padStart(2,'0')).join('');
  }
  globalThis.DhuBankCore = Object.freeze({TYPES,MARKER,MAX_ROWS,MAX_MESSAGE,object,own,first,isPracticePage,endpoint,validMeta,cleanMeta,filterRow,bridgeMessage,text,normalize,unpack,stable,content,fingerprint});
})();
