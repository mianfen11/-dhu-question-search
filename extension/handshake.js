/* ISOLATED controller. Correlation tokens are public message IDs, not auth secrets. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore;
  function start({onState,recover}) {
    const session=[...crypto.getRandomValues(new Uint8Array(16))].map(b=>b.toString(16).padStart(2,'0')).join('');
    let seq=0,running=false,confirmed=false,seen=false,ack=false,phase=null,recovery=null,recovering=false,everStarted=false,stopped=false;
    let timers=[];
    const timeoutMs=2000;
    const clear=()=>{timers.forEach(clearTimeout);timers=[];};
    const notify=(ready,reason,pending=false)=>onState({ready,reason,pending,ackSeen:ack,phase:phase||'unseen',bootstrapSeen:seen,attempt:seq,timeoutMs,recovery:recovering?'pending':recovery||'not_attempted'});
    const send=type=>{
      try {window.postMessage({marker:C.HANDSHAKE_MARKER,version:3,type,session,seq,phase:'booting'},'https://aidhu.net');}
      catch { /* Timeout classifies a broken communication path without guessing CSP. */ }
    };
    function finish(reason) {running=false;confirmed=false;clear();notify(false,reason);}
    function timeoutReason() {
      if(recovery && !['main_injection_ok','main_injection_failed','main_result_invalid'].includes(recovery))return recovery;
      const reason={core_missing:'main_core_missing',entities_missing:'main_entities_missing',observer_pending:'main_observer_pending',observer_init_failed:'main_observer_init_failed',fetch_patch_failed:'main_fetch_patch_failed',xhr_patch_failed:'main_xhr_patch_failed'}[phase];
      if(phase==='installed' && !ack)return 'main_ack_timeout';
      return reason || (recovery && recovery!=='main_injection_ok'?recovery:null) || (!seen?'main_bootstrap_timeout':!ack?'main_ack_timeout':'main_confirm_timeout');
    }
    async function attemptRecovery() {
      if(confirmed || recovering || recovery!==null)return;
      recovering=true;
      try {
        const r=await recover();
        const allowed=['main_injection_ok','main_csp_blocked','main_injection_denied','main_document_gone','main_document_unidentified','main_file_missing','main_injection_failed','main_result_invalid','main_core_missing','main_entities_missing','main_observer_pending','main_observer_init_failed','main_fetch_patch_failed','main_xhr_patch_failed'];
        recovery=allowed.includes(r?.reason)?r.reason:'main_result_invalid';
        if(r?.phase && C.MAIN_PHASES.includes(r.phase))phase=r.phase;
      } catch {recovery='main_injection_failed';}
      recovering=false;
      if(stopped)return;
      if(confirmed){notify(true,phase==='hook_replaced'?'hook_replaced':'ready_recovered');return;}
      if(!running && recovery!=='main_injection_ok'){notify(false,timeoutReason());return;}
      if(!running)probe();else send('challenge');
    }
    function probe() {
      if(running || stopped)return;
      if(seq>=1000000){finish('main_confirm_timeout');return;}
      running=true;confirmed=false;ack=false;seq++;
      if(!everStarted){everStarted=true;notify(false,'handshake_pending',true);}
      // Retry both startup orders. A hello is advisory, never a completed handshake.
      for(const ms of [100,250,500,1000,1500])timers.push(setTimeout(()=>{if(running)send('challenge');},ms));
      timers.push(setTimeout(attemptRecovery,350));
      timers.push(setTimeout(()=>finish(timeoutReason()),timeoutMs));
      send('challenge');
    }
    const listen=event=>{
      if(event.source!==window || event.origin!=='https://aidhu.net' || !C.isAppDocument(location.href))return;
      let d;try {d=C.handshake(event.data);}catch{return;}
      if(d.type==='hello') {seen=true;phase=d.phase;if(!running)probe();else send('challenge');notify(false,'handshake_pending',true);return;}
      if(!['ack','confirmed'].includes(d.type) || !running || d.session!==session || d.seq!==seq)return;
      seen=true;phase=d.phase;
      if(d.type==='ack'){ack=true;notify(false,'handshake_pending',true);send('confirm');}
      else if(d.type==='confirmed' && ack && ['installed','hook_replaced'].includes(d.phase)) {
        confirmed=true;running=false;clear();
        notify(true,d.phase==='hook_replaced'?'hook_replaced':recovery==='main_injection_ok'?'ready_recovered':'ready');
      }
    };
    window.addEventListener('message',listen,true);
    probe();
    return {probe,stop(){stopped=true;clear();running=false;window.removeEventListener?.('message',listen,true);}};
  }
  globalThis.DhuHandshake=Object.freeze({start});
})();
