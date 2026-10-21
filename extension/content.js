/* ISOLATED world. Treat both data and diagnostics from MAIN as untrusted. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore;
  let queue=[], draining=false, observerReady=false;
  const state={status:'not_injected',reason:'handshake_pending',captured:0,parsed:0,saved:0,rejected:0};
  const update=(status,reason)=>{state.status=status;state.reason=reason;};
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
        if (d.event==='ready') return; // An unsolicited ready is not a bidirectional handshake.
        if(C.isPracticePage(location.href)) {
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
  },true);
  // Ask MAIN to prove its listener is alive. No requests or question data are sent.
  chrome.runtime.onMessage?.addListener((message,sender,sendResponse)=>{
    if(message?.kind!=='diagnose' || sender.id!==chrome.runtime.id || sender.url!==chrome.runtime.getURL('popup.html'))return;
    handshake.probe();
    setTimeout(()=>sendResponse({ok:true,diagnostic:{...state,observerReady}}),150);
    return true;
  });
  const handshake=globalThis.DhuHandshake.start({
    recover:()=>chrome.runtime.sendMessage({kind:'ensure_main'}),
    onState:detail=>{
      state.handshake=detail;
      if(detail.pending)return;
      observerReady=detail.ready;
      if(!detail.ready)update('not_injected',detail.reason);
      else if(detail.reason==='hook_replaced')update('waiting','hook_replaced');
      else if(state.status==='not_injected' || (state.status==='waiting' && detail.reason==='ready_recovered'))update('waiting',detail.reason);
    }
  });
})();
