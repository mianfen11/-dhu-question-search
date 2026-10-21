const {test}=require('node:test');
const assert=require('node:assert/strict');
const {context,run,plain,page}=require('./helpers.cjs');
class Clock {
  now=0;next=1;tasks=new Map();
  set=(fn,ms=0)=>{const id=this.next++;this.tasks.set(id,{at:this.now+ms,fn});return id;};
  clear=id=>this.tasks.delete(id);
  tick(ms) {
    const until=this.now+ms;let steps=0;
    for(;;) {
      const due=[...this.tasks].filter(([,t])=>t.at<=until).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];
      if(!due)break;
      assert.ok(++steps<2000,'handshake must not create an infinite message loop');
      this.tasks.delete(due[0]);this.now=due[1].at;due[1].fn();
    }
    this.now=until;
  }
}
function harness({drop=()=>false,recover=async()=>({ok:false,reason:'main_injection_failed'})}={}) {
  const clock=new Clock(),listeners=[],messages=[],states=[];
  const window={fetch:()=>Promise.resolve(),addEventListener:(name,fn)=>listeners.push(fn),removeEventListener:(name,fn)=>{const i=listeners.indexOf(fn);if(i>=0)listeners.splice(i,1);},
    postMessage:message=>{messages.push(plain(message));if(!drop(message))clock.set(()=>listeners.slice().forEach(fn=>fn({source:window,origin:'https://aidhu.net',data:plain(message)})),0);}};
  const extra={window,location:{href:page},setTimeout:clock.set,clearTimeout:clock.clear};
  const main=context(extra),isolated=context(extra);
  let controller;
  const start=()=>controller=isolated.DhuHandshake.start({onState:s=>states.push(plain(s)),recover});
  const boot=()=>{run(main,'main-bootstrap.js');};
  const install=()=>run(main,'observer.js');
  const finish=()=>controller?.stop();
  return {clock,window,main,isolated,listeners,messages,states,start,boot,install,finish};
}
test('MAIN-first: an early lost hello is recovered by the isolated challenge',()=>{
  const h=harness();h.boot();h.install();h.clock.tick(0);h.start();h.clock.tick(0);
  assert.equal(h.states.at(-1).ready,true);
  assert.ok(['challenge','ack','confirm','confirmed'].every(type=>h.messages.some(m=>m.type===type)));
  for(const m of h.messages)h.isolated.DhuBankCore.handshake(m);
  h.finish();
});
test('ISOLATED-first: repeated challenges recover when MAIN arrives after startup',()=>{
  const h=harness();h.start();h.clock.tick(300);assert.equal(h.states.at(-1).ready,false);
  h.boot();h.install();h.clock.tick(0);assert.equal(h.states.at(-1).ready,true);
  h.finish();
});
test('2-second deadline distinguishes missing bootstrap, missing ack and missing confirm',()=>{
  for(const [kind,reason] of [['missing','main_bootstrap_timeout'],['ack','main_ack_timeout'],['confirmed','main_confirm_timeout']]) {
    const h=harness({drop:m=>m.type===kind});
    if(kind!=='missing'){h.boot();h.install();}
    h.start();h.clock.tick(2000);
    assert.equal(h.states.at(-1).reason,reason);assert.equal(h.states.at(-1).ready,false);h.finish();
  }
});
test('bootstrap reports missing MAIN dependency without relying on that dependency',()=>{
  const h=harness();h.main.DhuBankCore=undefined;h.boot();h.start();h.clock.tick(2000);
  assert.equal(h.states.at(-1).reason,'main_core_missing');h.finish();
});
test('initialization exception is explicit, does not set installed, and can be retried',()=>{
  const h=harness();Object.defineProperty(h.window,'fetch',{value:h.window.fetch,writable:false,configurable:true});
  h.boot();h.install();assert.equal(h.main.__dhuMainBridgeV3.observerInstalled,false);
  h.start();h.clock.tick(2000);assert.equal(h.states.at(-1).reason,'main_fetch_patch_failed');
  Object.defineProperty(h.window,'fetch',{value:()=>Promise.resolve(),writable:true,configurable:true});
  h.install();h.clock.tick(0);assert.equal(h.states.at(-1).ready,true);h.finish();
});
test('matching session and round-trip confirmation are required; old ready, wrong nonce and stale sequence cannot pass',()=>{
  const h=harness({drop:()=>true});h.start();
  const challenge=h.messages.find(m=>m.type==='challenge');
  for(const data of [{marker:h.isolated.DhuBankCore.DIAG_MARKER,version:1,event:'ready',reason:'ready',count:0},
    {...challenge,type:'confirmed',phase:'installed'},
    {...challenge,type:'ack',session:'b'.repeat(32),phase:'installed'},
    {...challenge,type:'ack',seq:99,phase:'installed'}])
    h.listeners.forEach(fn=>fn({source:h.window,origin:'https://aidhu.net',data}));
  for(const [source,origin] of [[{},'https://aidhu.net'],[h.window,'https://evil.test']])
    h.listeners.forEach(fn=>fn({source,origin,data:{...challenge,type:'ack',phase:'installed'}}));
  assert.equal(h.states.at(-1).ready,false);h.finish();
});
test('programmatic recovery returns a concrete CSP/permission result without raw error text',async()=>{
  for(const reason of ['main_csp_blocked','main_injection_denied','main_file_missing']) {
    let calls=0;
    const h=harness({recover:async()=>{calls++;return {ok:false,reason,error:'sensitive-url-token'};}});
    h.start();h.clock.tick(350);await new Promise(setImmediate);h.clock.tick(1650);
    assert.equal(calls,1);assert.equal(h.states.at(-1).reason,reason);
    assert.equal(JSON.stringify(h.states).includes('sensitive'),false);h.finish();
  }
});
test('Chrome confirms MAIN installation but all page messages are blocked: diagnose ack timeout, not CSP',async()=>{
  const h=harness({drop:()=>true,recover:async()=>({ok:true,reason:'main_injection_ok',phase:'installed'})});
  h.start();h.clock.tick(350);await new Promise(setImmediate);h.clock.tick(1650);
  assert.equal(h.states.at(-1).reason,'main_ack_timeout');h.finish();
});
test('successful recovery triggers a fresh handshake, and duplicate injection does not rewrap fetch',async()=>{
  let h,calls=0;
  h=harness({recover:async()=>{calls++;h.boot();h.install();return {ok:true,reason:'main_injection_ok',phase:'installed'};}});
  h.start();h.clock.tick(350);await new Promise(setImmediate);h.clock.tick(0);
  assert.equal(h.states.at(-1).ready,true);assert.equal(calls,1);
  const wrapped=h.window.fetch;h.boot();h.install();h.clock.tick(0);
  assert.equal(h.window.fetch,wrapped);h.finish();
});

test('an old boolean installed flag cannot suppress the new MAIN bootstrap',()=>{
  const h=harness();h.main.__dhuObserverInstalled=true;h.boot();h.install();h.start();h.clock.tick(0);
  assert.equal(h.states.at(-1).ready,true);h.finish();
});

test('bootstrap listener registration failure leaves no installed marker and permits retry',()=>{
  const h=harness(),add=h.window.addEventListener;h.window.addEventListener=()=>{throw new Error('listener registration failed');};
  assert.throws(h.boot);assert.equal(h.main.__dhuMainBridgeV3,undefined);
  h.window.addEventListener=add;h.boot();h.install();h.start();h.clock.tick(0);
  assert.equal(h.states.at(-1).ready,true);h.finish();
});
