/* ISOLATED world. Treat both data and diagnostics from MAIN as untrusted. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore;
  let queue=[], draining=false, observerReady=false;
  const state={status:'not_injected',reason:'observer_missing',captured:0,parsed:0,saved:0,rejected:0};
  const update=(status,reason)=>{state.status=status;state.reason=reason;};
  const probe=()=>window.postMessage?.({marker:C.DIAG_MARKER,version:1,event:'probe',reason:'none',count:0},'https://aidhu.net');
  async function drain() {
    if (draining) return;
    draining=true;
    while (queue.length) {
      const {message,href}=queue.shift();
      state.parsed+=message.questions.length;update('saving','saving');
      try {
        const response=await chrome.runtime.sendMessage({kind:'collect',pageHref:href,payload:message});
        if (!response?.ok) {
          const reason=C.DIAG_REASONS.includes(response?.reason)?response.reason:'background_unreachable';
          update(response?.stage==='parse_error'?'parse_error':'storage_error',reason);
        } else if (!C.object(response.result) || !['added','duplicates','rejected'].every(k=>Number.isSafeInteger(response.result[k]) && response.result[k]>=0) ||
            response.result.added+response.result.duplicates+response.result.rejected!==message.questions.length) {
          update('storage_error','background_unreachable');
        } else if (response.result.rejected && !response.result.added && !response.result.duplicates) {
          state.rejected+=response.result.rejected;update('parse_error','normalization');
        } else {
          state.saved+=(response.result?.added||0)+(response.result?.duplicates||0);
          state.rejected+=response.result?.rejected||0;update('saved','saved');
        }
      } catch { update('storage_error','background_unreachable'); }
    }
    draining=false;
  }
  window.addEventListener('message',event => {
    if (event.source !== window || event.origin !== 'https://aidhu.net' || !C.isAppDocument(location.href)) return;
    if (event.data?.marker===C.DIAG_MARKER) {
      try {
        const d=C.diagnostic(event.data);
        if (d.event==='probe') return;
        if (d.event==='ready') {
          observerReady=true;
          if(d.reason==='hook_replaced')update('waiting','hook_replaced');
          else if(state.status==='not_injected')update('waiting','ready');
        } else if(C.isPracticePage(location.href)) {
          observerReady=true;
          if(d.event==='captured') { state.captured++;update('captured','response_pending'); }
          else if(d.event==='parse_error'){
            state.rejected+=d.count;
            update(d.reason==='network'?'waiting':d.reason==='empty'?'captured':'parse_error',d.reason);
          }
        }
      } catch { /* Unknown diagnostic payloads are not displayed or retained. */ }
      return;
    }
    if(event.data?.marker!==C.MARKER || !C.isPracticePage(location.href))return;
    try {
      const safe=C.bridgeMessage(event.data,location.href);
      if(queue.length>=200) {update('parse_error','queue_full');return;}
      queue.push({message:safe,href:location.href});void drain();
    } catch {update('parse_error','bridge_rejected');}
  });
  // Ask MAIN to prove its listener is alive. No requests or question data are sent.
  chrome.runtime.onMessage?.addListener((message,sender,sendResponse)=>{
    if(message?.kind!=='diagnose' || sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('popup.html'))return;
    probe();
    setTimeout(()=>sendResponse({ok:true,diagnostic:{...state,observerReady}}),150);
    return true;
  });
  probe();
})();
