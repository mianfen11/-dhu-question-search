'use strict';
importScripts('entities.js','core.js','store.js');
const C=globalThis.DhuBankCore, S=globalThis.DhuBankStore;
// Only extension contexts may directly access storage, never content scripts.
const storageReady=chrome.storage.local.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
let tail=Promise.resolve();
const popupURL=chrome.runtime.getURL('popup.html');
function validSite(url) {
  try { const u=new URL(url); return u.origin==='https://aidhu.net' && u.pathname.startsWith('/web/'); }
  catch { return false; }
}
async function handle(message,sender) {
  if (sender.id !== chrome.runtime.id || !C.object(message)) throw new Error('来源无效');
  const isPopup=sender.url===popupURL;
  let rows;
  if (message.kind==='collect') {
    // sender.tab.url is tab metadata, not a reliable Vue hash-route clock.
    // Authenticate the sending document; the isolated bridge validates its live href.
    if (!sender.tab || sender.frameId!==0 || !validSite(sender.url) || !C.isPracticePage(message.pageHref)) throw new Error('收集来源无效');
    const safe=C.bridgeMessage(message.payload,message.pageHref);
    rows=safe.questions;
  } else if (!isPopup) throw new Error('仅弹窗可操作本地题库');
  await storageReady;
  const state=await S.load(chrome.storage.local);
  if (message.kind==='stats') return {ok:true,stats:S.summary(state)};
  if (message.kind==='export') return {ok:true,bank:S.exportBank(state)};
  if (message.kind==='import') {
    if (typeof message.json !== 'string' || message.json.length > 20*1024*1024) throw new Error('导入文件过大（最多 20 MB）');
    rows=C.unpack(JSON.parse(message.json.replace(/^\ufeff/,'')));
  }
  if (!rows) throw new Error('未知操作');
  const merged=await S.merge(state,rows);
  try { await chrome.storage.local.set({[S.KEY]:merged.state}); }
  catch { throw new Error('本地保存失败，可能超出 Chrome 存储配额；请先导出现有题库'); }
  return {ok:true,result:merged.result,stats:S.summary(merged.state)};
}
chrome.runtime.onMessage.addListener((message,sender,sendResponse) => {
  // Returning true keeps the channel/worker alive until the serialized operation completes.
  const task=tail.then(() => handle(message,sender));
  tail=task.catch(() => {});
  task.then(sendResponse,error => sendResponse({ok:false,error:error.message || '操作失败'}));
  return true;
});
