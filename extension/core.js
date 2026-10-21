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
  const DIAG_MARKER = 'dhu-question-bank/diagnostic-v1';
  const DIAG_REASONS = Object.freeze(['none','ready','response_pending','json','shape','size','row_schema','endpoint_context','http_status','redirect','network','unsupported_xhr','bridge_rejected','queue_full','saving','normalization','storage_access','storage_read','storage_write','background_unreachable','saved','empty','observer_missing','bridge_missing','diagnostic_invalid','hook_replaced','handshake_pending','main_bootstrap_timeout','main_ack_timeout','main_confirm_timeout','main_core_missing','main_entities_missing','main_observer_pending','main_observer_init_failed','main_fetch_patch_failed','main_xhr_patch_failed','main_csp_blocked','main_injection_denied','main_document_gone','main_document_unidentified','main_file_missing','main_injection_failed','main_result_invalid','ready_recovered']);
  function diagnostic(value) {
    if (!object(value) || Object.keys(value).sort().join(',') !== 'count,event,marker,reason,version' ||
        value.marker !== DIAG_MARKER || value.version !== 1 || !['probe','ready','captured','parse_error'].includes(value.event) ||
        !DIAG_REASONS.includes(value.reason) || !Number.isSafeInteger(value.count) || value.count < 0 || value.count > 10000) throw new Error('诊断消息无效');
    return {marker:DIAG_MARKER,version:1,event:value.event,reason:value.reason,count:value.count};
  }
  const HANDSHAKE_MARKER='dhu-question-bank/handshake-v3';
  const MAIN_PHASES=Object.freeze(['booting','core_missing','entities_missing','observer_pending','observer_init_failed','fetch_patch_failed','xhr_patch_failed','installed','hook_replaced']);
  function handshake(d) {
    if(!object(d) || Object.keys(d).sort().join(',')!=='marker,phase,seq,session,type,version' || d.marker!==HANDSHAKE_MARKER || d.version!==3 ||
        !['hello','challenge','ack','confirm','confirmed'].includes(d.type) || !MAIN_PHASES.includes(d.phase) || !Number.isSafeInteger(d.seq) || d.seq<0 || d.seq>1000000 ||
        typeof d.session!=='string' || (d.type==='hello'?d.session!=='' || d.seq!==0:!/^[a-f0-9]{32}$/.test(d.session) || d.seq<1))throw new Error('握手消息无效');
    return {marker:HANDSHAKE_MARKER,version:3,type:d.type,session:d.session,seq:d.seq,phase:d.phase};
  }
  function isAppDocument(href) {
    try { const u=new URL(href); return u.origin === 'https://aidhu.net' && (u.pathname === '/' || u.pathname.startsWith('/web/')); }
    catch { return false; }
  }
  function isQuestionURL(url,base) {
    try { const u=new URL(url,base); return u.origin==='https://api.aidhu.net' && !u.username && !u.password && !u.hash && TYPES.some(t=>u.pathname===PREFIX+t); }
    catch { return false; }
  }
  const QUEUE_MARKER='dhu-question-bank/queue-v1';
  function captureInfo(c) {
    if(!object(c)||!['batch_count,batch_index,response_id','batch_count,batch_index,rejected_rows,response_id'].includes(Object.keys(c).sort().join(','))||typeof c.response_id!=='string'||
      !/^[a-f0-9-]{36}$/.test(c.response_id)||!Number.isInteger(c.batch_count)||c.batch_count<1||c.batch_count>1000||
      !Number.isInteger(c.batch_index)||c.batch_index<0||c.batch_index>=c.batch_count)throw new Error('响应批次标识无效');
    if(c.rejected_rows!=null && (!Number.isInteger(c.rejected_rows)||c.rejected_rows<0||c.rejected_rows>10000))throw new Error('响应拒绝数无效');
    return {response_id:c.response_id,batch_index:c.batch_index,batch_count:c.batch_count,rejected_rows:c.rejected_rows||0};
  }
  function chapterEndpoint(url,base) {
    try {
      const u=new URL(url,base),manual=u.searchParams.get('manual_id');
      if(u.origin!=='https://api.aidhu.net'||u.username||u.password||u.hash||u.pathname!=='/api/protected/app/manual/chapters'||
        u.searchParams.getAll('manual_id').length!==1||!/^[1-9]\d{0,15}$/.test(manual))return null;
      return {kind:'chapters',manual_id:manual};
    }catch{return null;}
  }
  function queueMessage(d) {
    if(!object(d)||d.marker!==QUEUE_MARKER||d.version!==1)throw new Error('队列消息无效');
    if(d.event==='blocked' && Object.keys(d).sort().join(',')==='event,marker,status,version' && [401,403,429].includes(d.status))
      return {marker:QUEUE_MARKER,version:1,event:'blocked',status:d.status};
    if(d.event==='empty' && Object.keys(d).sort().join(',')==='capture,event,marker,meta,version' && validMeta(d.meta)) {
      const capture=captureInfo(d.capture);if(capture.batch_count!==1||capture.batch_index!==0||capture.rejected_rows)throw new Error('空响应标识无效');
      return {marker:QUEUE_MARKER,version:1,event:'empty',meta:cleanMeta(d.meta),capture};
    }
    if(d.event!=='chapters'||Object.keys(d).sort().join(',')!=='chapters,event,manual_id,marker,version'||
      typeof d.manual_id!=='string'||!/^[1-9]\d{0,15}$/.test(d.manual_id)||!Array.isArray(d.chapters)||!d.chapters.length||d.chapters.length>500)throw new Error('章节清单无效');
    const seen=new Set();
    const chapters=d.chapters.map(c=>{
      if(!object(c)||Object.keys(c).sort().join(',')!=='chapter_id,name'||typeof c.chapter_id!=='string'||!/^[1-9]\d{0,15}$/.test(c.chapter_id)||
        typeof c.name!=='string'||!c.name.trim()||c.name.length>200||seen.has(c.chapter_id))throw new Error('章节字段无效');
      seen.add(c.chapter_id);return {chapter_id:c.chapter_id,name:c.name.normalize('NFC').trim()};
    });
    return {marker:QUEUE_MARKER,version:1,event:'chapters',manual_id:d.manual_id,chapters};
  }
  function isPracticePage(href) {
    try {
      const u = new URL(href);
      if (!isAppDocument(href)) return false;
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
    if (!['marker,meta,questions,version','capture,marker,meta,questions,version'].includes(Object.keys(data).sort().join(','))) throw new Error('消息包含未知字段');
    const safe = {marker:MARKER, version:1, meta:cleanMeta(data.meta), questions:data.questions.map(q => filterRow(q,data.meta))};
    if(own(data,'capture'))safe.capture=captureInfo(data.capture);
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
  globalThis.DhuBankCore = Object.freeze({TYPES,MARKER,QUEUE_MARKER,captureInfo,chapterEndpoint,queueMessage,HANDSHAKE_MARKER,MAIN_PHASES,handshake,DIAG_MARKER,DIAG_REASONS,diagnostic,isAppDocument,isQuestionURL,MAX_ROWS,MAX_MESSAGE,object,own,first,isPracticePage,endpoint,validMeta,cleanMeta,filterRow,bridgeMessage,text,normalize,unpack,stable,content,fingerprint});
})();
