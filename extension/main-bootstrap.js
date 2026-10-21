/* First MAIN script: self-contained so missing dependencies remain diagnosable. */
(() => {
  'use strict';
  const key='__dhuMainBridgeV3', marker='dhu-question-bank/handshake-v3';
  if(globalThis[key]?.version===3 && typeof globalThis[key].announce==='function') {
    globalThis[key].announce();return;
  }
  const phases=['booting','core_missing','entities_missing','observer_pending','observer_init_failed','fetch_patch_failed','xhr_patch_failed','installed','hook_replaced'];
  const post=window.postMessage.bind(window), sessions=new Map();
  const state={version:3,observerInstalled:false,failure:null,health:null};
  state.phase=()=>{
    if(state.failure)return state.failure;
    if(state.observerInstalled) {
      try {return state.health?.()?'hook_replaced':'installed';}catch{return 'observer_init_failed';}
    }
    if(!globalThis.DhuBankCore)return 'core_missing';
    if(!globalThis.DhuEntities)return 'entities_missing';
    return 'observer_pending';
  };
  const send=(type,session='',seq=0)=>{
    try {post({marker,version:3,type,session,seq,phase:state.phase()},'https://aidhu.net');}catch{/* Never log page data. */}
  };
  state.announce=()=>send('hello');
  state.fail=phase=>{state.failure=phases.includes(phase)?phase:'observer_init_failed';state.announce();};
  window.addEventListener('message',event=>{
    if(event.source!==window || event.origin!=='https://aidhu.net')return;
    const d=event.data;
    if(!d || Object.keys(d).sort().join(',')!=='marker,phase,seq,session,type,version' ||
        d.marker!==marker || d.version!==3 || !['challenge','confirm'].includes(d.type) || d.phase!=='booting' ||
        typeof d.session!=='string' || !/^[a-f0-9]{32}$/.test(d.session) || !Number.isSafeInteger(d.seq) || d.seq<1 || d.seq>1000000)return;
    if(d.type==='challenge') {
      if(sessions.size>=16 && !sessions.has(d.session))sessions.delete(sessions.keys().next().value);
      sessions.set(d.session,d.seq);send('ack',d.session,d.seq);
    } else if(sessions.get(d.session)===d.seq)send('confirmed',d.session,d.seq);
  },true);
  Object.defineProperty(globalThis,key,{value:state,configurable:true});
  state.announce();
})();
