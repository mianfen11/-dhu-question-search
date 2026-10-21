'use strict';
importScripts('entities.js','core.js','store.js','queue.js','auto-runner.js');
const C=globalThis.DhuBankCore, S=globalThis.DhuBankStore, Q=globalThis.DhuQueue;
// Only extension contexts may directly access storage, never content scripts.
const storageReady=Promise.resolve().then(()=>chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'})).then(()=>true,()=>false);
let tail=Promise.resolve();
const popupURL=chrome.runtime.getURL('popup.html');
function serial(fn){const task=tail.then(fn);tail=task.catch(()=>{});return task;}
let autoTimer=null;
function armAlarm(when){
  const created=chrome.alarms?.create('dhu-auto',{when:Math.max(when,Date.now()+30000)});
  created?.catch?.(()=>{});
}
const automatic=DhuAutoRunner.create({
  now:()=>Date.now(),serial,watchdog:()=>armAlarm(Date.now()+30000),
  load:async()=>{if(!await storageReady)throw new Error('storage_error');return S.load(chrome.storage.local);},
  save:state=>chrome.storage.local.set({[S.KEY]:state}),
  schedule:when=>{
    clearTimeout(autoTimer);
    autoTimer=setTimeout(()=>void automatic.tick(),Math.max(0,when-Date.now()));
    // Alarms survive worker eviction; Chrome may deliver them later than the fast timer.
    armAlarm(when);
  },
  execute:async(a,command)=>{
    const target=a.document_id?{tabId:a.tab_id,documentIds:[a.document_id]}:{tabId:a.tab_id,frameIds:[0]};
    if(command.op==='info')await chrome.scripting.executeScript({target,world:'MAIN',injectImmediately:true,
      files:['main-bootstrap.js','entities.js','core.js','observer.js','auto-page.js']});
    const results=await chrome.scripting.executeScript({target,world:'MAIN',injectImmediately:true,
      func:async command=>globalThis.DhuAutoPage?globalThis.DhuAutoPage.run(command):{ok:false,reason:'client_unavailable'},args:[command]});
    if(!results?.[0])throw new Error('page_unavailable');
    return {result:results[0].result,documentId:results[0].documentId};
  }
});
chrome.alarms?.onAlarm.addListener(alarm=>{if(alarm.name==='dhu-auto')void automatic.tick();});
chrome.runtime.onStartup?.addListener(()=>void automatic.tick());
chrome.runtime.onInstalled?.addListener(()=>void automatic.tick());
// A wake reads persisted state. It never creates a plan without a popup command.
void automatic.tick();
function validSite(url) {
  return C.isAppDocument(url);
}
// Injection is restricted to the authenticated top-level content-script document.
function injectionFailure(error) {
  const message=String(error?.message||'');
  if(/content security policy|\bCSP\b|refused to execute/i.test(message))return 'main_csp_blocked';
  if(/permission|cannot access|not allowed|disabled|cannot be scripted/i.test(message))return 'main_injection_denied';
  if(/no (?:frame|document|tab)|frame.*removed|document.*(?:removed|unloaded)|tab.*closed/i.test(message))return 'main_document_gone';
  if(/could not load file|cannot find|failed to load.*file/i.test(message))return 'main_file_missing';
  return 'main_injection_failed';
}
async function ensureMain(sender) {
  if(!Number.isInteger(sender.tab?.id) || typeof sender.documentId!=='string' || !/^[a-zA-Z0-9-]{1,128}$/.test(sender.documentId))
    return {ok:false,reason:'main_document_unidentified'};
  const target={tabId:sender.tab.id,documentIds:[sender.documentId]};
  try {
    await chrome.scripting.executeScript({target,world:'MAIN',injectImmediately:true,
      files:['main-bootstrap.js','entities.js','core.js','observer.js']});
    const results=await chrome.scripting.executeScript({target,world:'MAIN',injectImmediately:true,func:()=>{
      const boot=globalThis.__dhuMainBridgeV3;
      return boot?.version===3 && typeof boot.phase==='function'?boot.phase():'unseen';
    }});
    const phase=results?.[0]?.result;
    const reasons={core_missing:'main_core_missing',entities_missing:'main_entities_missing',observer_pending:'main_observer_pending',observer_init_failed:'main_observer_init_failed',fetch_patch_failed:'main_fetch_patch_failed',xhr_patch_failed:'main_xhr_patch_failed'};
    if(['installed','hook_replaced'].includes(phase))return {ok:true,reason:'main_injection_ok',phase};
    return {ok:false,reason:reasons[phase]||'main_result_invalid',...(C.MAIN_PHASES.includes(phase)?{phase}:{})};
  } catch(error) {return {ok:false,reason:injectionFailure(error)};}
}
async function handle(message,sender) {
  if (sender.id !== chrome.runtime.id || !C.object(message)) throw new Error('来源无效');
  const isPopup=sender.url===popupURL;
  if(message.kind==='ensure_main') {
    if(Object.keys(message).join(',')!=='kind' || !sender.tab || sender.frameId!==0 || !validSite(sender.url))throw new Error('注入来源无效');
    return ensureMain(sender);
  }
  let rows,safeCapture=null,meta=null,platformEvent=null;
  if (message.kind==='collect') {
    // sender.tab.url is tab metadata, not a reliable Vue hash-route clock.
    // Authenticate the sending document; the isolated bridge validates its live href.
    if (!sender.tab || sender.frameId!==0 || !validSite(sender.url) || !C.isPracticePage(message.pageHref)) throw new Error('收集来源无效');
    try { const safe=C.bridgeMessage(message.payload,message.pageHref);rows=safe.questions;safeCapture=safe.capture||null;meta=safe.meta; }
    catch { return {ok:false,stage:'parse_error',reason:'bridge_rejected',error:'题目消息未通过校验'}; }
  } else if(message.kind==='platform_event') {
    if(!sender.tab || sender.frameId!==0 || !validSite(sender.url))throw new Error('平台观测来源无效');
    platformEvent=C.queueMessage(message.payload);
  } else if (!isPopup) throw new Error('仅弹窗可操作本地题库');
  if(!await storageReady)return {ok:false,stage:'storage_error',reason:'storage_access',error:'无法初始化扩展本地存储权限'};
  let state;
  try { state=await S.load(chrome.storage.local); }
  catch { return {ok:false,stage:'storage_error',reason:'storage_read',error:'读取本地题库失败，原数据未改动'}; }
  if (message.kind==='stats') return {ok:true,stats:automatic.stats(state)};
  if(message.kind==='auto_start'||message.kind==='auto_control') {
    const next=await automatic.command(state,message);
    if(next.automation.status!=='running')void automatic.cancel(next.automation);
    try{await chrome.storage.local.set({[S.KEY]:next});}
    catch{return {ok:false,error:'自动计划写入失败，请检查本地存储；暂停/停止已阻止本次后台继续派发'};}
    setTimeout(()=>void automatic.tick(),0);
    return {ok:true,stats:automatic.stats(next)};
  }
  if(message.kind==='queue_control'&&state.automation&&['running','paused'].includes(state.automation.status))throw new Error('请使用自动计划控制按钮');
  if(message.kind==='queue_control' || platformEvent) {
    const queue=platformEvent?(platformEvent.event==='chapters'?Q.catalog(Q.read(state),platformEvent):platformEvent.event==='empty'?(state.automation?Q.read(state):Q.observe(Q.read(state),platformEvent.meta,platformEvent.capture,{added:0,duplicates:0,rejected:0})):Q.blocked(Q.read(state),platformEvent.status)):
      Q.control(Q.read(state),message.action,{manual_id:message.manual_id,rounds:message.rounds});
    const next={...state,queue};
    if(message.kind==='queue_control'&&message.action==='start'&&!next.automation?.inflight)delete next.automation;
    if(platformEvent?.event==='blocked'&&next.automation?.status==='running'){
      next.automation={...next.automation,status:'paused',last_error:'http_'+platformEvent.status};
      void automatic.cancel(next.automation);
    }
    try {await chrome.storage.local.set({[S.KEY]:next});}
    catch {return {ok:false,error:'离线队列保存失败，原数据未覆盖'};}
    return {ok:true,stats:automatic.stats(next)};
  }
  if (message.kind==='export') return {ok:true,bank:S.exportBank(state)};
  if (message.kind==='import') {
    if (typeof message.json !== 'string' || message.json.length > 20*1024*1024) throw new Error('导入文件过大（最多 20 MB）');
    rows=C.unpack(JSON.parse(message.json.replace(/^\ufeff/,'')));
  }
  if (!rows) throw new Error('未知操作');
  const merged=await S.merge(state,rows);
  if(message.kind==='collect')merged.state.queue=state.automation?Q.read(state):Q.observe(Q.read(state),meta,safeCapture,merged.result);
  try { await chrome.storage.local.set({[S.KEY]:merged.state}); }
  catch { return {ok:false,stage:'storage_error',reason:'storage_write',error:'本地保存失败，可能超出 Chrome 存储配额；原题库未覆盖'}; }
  return {ok:true,result:merged.result,stats:automatic.stats(merged.state)};
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  // Returning true keeps the channel/worker alive until the serialized operation completes.
  const task=serial(() => handle(message,sender));
  task.then(sendResponse,error => sendResponse({ok:false,error:error.message || '操作失败'}));
  return true;
});
