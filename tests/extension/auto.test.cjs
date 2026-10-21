const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {context,run,plain,row,page,url}=require('./helpers.cjs');
const catalog={marker:'dhu-question-bank/queue-v1',version:1,event:'chapters',manual_id:'1',chapters:[{chapter_id:'1',name:'一'},{chapter_id:'2',name:'二'}]};
function harness(){
  const c=context();for(const file of ['store.js','queue.js','auto-runner.js'])run(c,file);
  let state=plain(c.DhuBankStore.empty()),now=100000,failSave=false;
  const requests=[],probes=[],scheduled=[],receipts=new Map();let watchdogs=0;
  let responder=async command=>command.kind==='chapters'?{ok:true,chapters:catalog}:{ok:true,rejected:0,questions:[row({
    manual_id:'1',chapter_id:command.chapter_id,question_type:command.kind,
    A:command.kind==='judge'?null:'甲',B:command.kind==='judge'?null:'乙',question:command.kind==='judge'?'判断':'模拟题',answer:command.kind==='judge'?'1':command.kind==='multi_choice'?'AB':'A',source:'出处',analysis:'解析内容'})]};
  let tail=Promise.resolve();
  const io={now:()=>now,watchdog:()=>watchdogs++,serial:fn=>{const task=tail.then(fn);tail=task.catch(()=>{});return task;},
    load:async()=>structuredClone(state),save:async next=>{if(failSave)throw new Error('quota');state=plain(next);},schedule:when=>scheduled.push(when),
    execute:async(a,command)=>{
      if(command.op==='info')return {documentId:'doc-1',result:{ok:true,manual_id:'1'}};
      if(command.op==='cancel')return {result:{ok:true}};
      if(command.op==='probe'){probes.push(command.id);return {result:await (receipts.get(command.id)||{ok:false,reason:'receipt_missing'})};}
      requests.push(plain(command));const pending=responder(command);receipts.set(command.id,pending);return {result:await pending};
    }};
  let runner=c.DhuAutoRunner.create(io);
  const command=message=>io.serial(async()=>{const next=await runner.command(await io.load(),message);await io.save(next);return next;});
  return {c,io,requests,probes,scheduled,receipts,command,get watchdogs(){return watchdogs;},get state(){return state;},get runner(){return runner;},
    restart(){runner=c.DhuAutoRunner.create(io);},setRespond:fn=>responder=fn,failSave:v=>failSave=v,
    start:options=>command({kind:'auto_start',tab_id:7,...options}),
    next:async()=>{now=Math.max(now,state.automation?.next_at||0);await runner.tick();},
    advance:ms=>now+=ms};
}
test('automatic plan obtains chapter map then serially executes all chapters/types and stops',async()=>{
  const h=harness();assert.equal(h.requests.length,0);await h.start();
  await h.next();assert.equal(h.requests[0].kind,'chapters');assert.equal(h.state.queue.tasks.length,6);
  for(let i=0;i<6;i++)await h.next();
  assert.deepEqual(h.requests.slice(1).map(r=>[r.chapter_id,r.kind]),[['1','one_choice'],['1','multi_choice'],['1','judge'],['2','one_choice'],['2','multi_choice'],['2','judge']]);
  assert.equal(h.state.automation.status,'completed');assert.equal(h.state.questions.length,3);
  assert.deepEqual(h.state.automation.round_results,[{round:1,added:3}]);
  assert.deepEqual(h.state.questions[0].contexts,[{manual_id:'1',chapter_id:'1'},{manual_id:'1',chapter_id:'2'}]);
  await h.next();assert.equal(h.requests.length,7);
});
test('minimum delay is enforced between completion and next request; defaults are finite',async()=>{
  const h=harness();await h.start();assert.equal(h.state.automation.interval_ms,5000);assert.equal(h.state.automation.rounds,1);
  await h.next();await h.runner.tick();h.advance(4999);await h.runner.tick();assert.equal(h.requests.length,1);
  h.advance(1);await h.runner.tick();assert.equal(h.requests.length,2);
  for(const options of [{interval_seconds:4},{interval_seconds:0},{rounds:11},{rounds:0}])await assert.rejects(harness().start(options));
});
test('finite multiple rounds keep zero-new rounds and report each round without claiming completeness',async()=>{
  const h=harness();await h.start({rounds:2,interval_seconds:30});
  for(let i=0;i<13;i++)await h.next();
  assert.equal(h.state.automation.status,'completed');assert.equal(h.state.queue.tasks.length,12);
  assert.deepEqual(h.state.automation.round_results,[{round:1,added:3},{round:2,added:0}]);
  const stats=h.runner.stats(h.state);assert.equal(stats.queue.progress.duplicates,9);assert.equal(stats.queue.completeness,'unverified');
});
test('pause and resume preserve task progress; stop prevents further requests',async()=>{
  const h=harness();await h.start();await h.next();await h.next();
  await h.command({kind:'auto_control',action:'pause'});await h.next();assert.equal(h.requests.length,2);
  await h.command({kind:'auto_control',action:'resume',tab_id:7});await h.next();assert.equal(h.requests[2].kind,'multi_choice');
  await h.command({kind:'auto_control',action:'stop'});await h.next();assert.equal(h.requests.length,3);assert.equal(h.state.automation.status,'stopped');
});
for(const reason of ['http_401','http_403','http_429','network_error','request_aborted'])test(reason+' pauses without automatic retry',async()=>{
  const h=harness();await h.start();h.setRespond(async()=>({ok:false,reason}));await h.next();
  assert.equal(h.state.automation.status,'paused');assert.equal(h.state.automation.last_error,reason);
  await h.next();assert.equal(h.requests.length,1);
});
test('popup-independent coordinator recovers worker sleep between tasks without repeating completed tasks',async()=>{
  const h=harness();await h.start();await h.next();await h.next();h.restart();
  await h.next();assert.equal(h.requests[2].kind,'multi_choice');assert.equal(h.state.queue.tasks.filter(t=>t.status==='observed').length,2);
});
test('worker interrupted after HTTP but before commit probes same document receipt without replay',async()=>{
  const h=harness();await h.start();await h.next();
  h.setRespond(async command=>{h.failSave(true);return {ok:true,rejected:0,questions:[row({manual_id:'1',chapter_id:command.chapter_id})]};});
  await h.next();const id=h.state.automation.inflight.id;assert.equal(h.state.questions.length,0);
  h.failSave(false);h.restart();await h.next();
  assert.equal(h.requests.length,2);assert.deepEqual(h.probes,[id]);assert.equal(h.state.questions.length,1);assert.equal(h.state.automation.inflight,null);
});
test('lost page receipt after worker interruption pauses instead of issuing uncertain duplicate request',async()=>{
  const h=harness();await h.start();h.setRespond(async()=>{h.failSave(true);return {ok:true,chapters:catalog};});await h.next();
  h.failSave(false);h.receipts.clear();h.restart();await h.next();
  assert.equal(h.requests.length,1);assert.equal(h.state.automation.last_error,'receipt_missing');assert.equal(h.state.automation.status,'paused');
});
test('two tabs cannot start or execute the same queue concurrently, and pause is not blocked by HTTP',async()=>{
  const h=harness();await h.start();await assert.rejects(h.start({tab_id:8}));
  let release;h.setRespond(()=>new Promise(resolve=>release=resolve));
  const active=h.next();await new Promise(r=>setImmediate(r));await h.runner.tick();
  assert.equal(h.requests.length,1);assert.equal(h.watchdogs,1,'an alarm during a live request must rearm recovery');
  await h.command({kind:'auto_control',action:'pause'});assert.equal(h.state.automation.status,'paused');
  release({ok:true,chapters:catalog});await active;
  assert.equal(h.state.automation.status,'paused');assert.equal(h.state.queue.status,'paused');
});
test('automatic export retains fields, cross-chapter contexts, conflicts and Python compatibility',async()=>{
  const h=harness();await h.start();for(let i=0;i<7;i++)await h.next();
  let state=(await h.c.DhuBankStore.merge(h.state,[row({manual_id:'1',chapter_id:'2',answer:'B'}),row({manual_id:'1',chapter_id:'3',A:'不同选项'})])).state;
  const bank=h.c.DhuBankStore.exportBank(state);assert.equal(bank.questions.length,5);assert.ok(bank.report.conflict_count>0);
  assert.equal(bank.questions[0].source,'出处');assert.equal(bank.questions[0].analysis,'解析内容');
  const py=spawnSync('python3',['-c','import json,sys;from tools.question_bank import import_documents;b=import_documents([("auto",json.load(sys.stdin))]);assert not b["report"]["rejected"];assert len(b["questions"])==5'],{input:JSON.stringify(bank),encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);
});
function pageHarness(options={}){
  const handlers=[],calls=[],location={href:page,get hash(){return new URL(this.href).hash;}};let response=options.response||{code:200,data:[row({headers:{Authorization:'secret-marker'}})]};
  const window={addEventListener:(n,fn)=>handlers.push(fn),postMessage:()=>{},fetch:async(target,init)=>{
    calls.push({target,params:new URL(target).searchParams.toString()});
    if(options.network)throw new Error('private-token-error');
    if(options.hang)return new Promise((resolve,reject)=>init.signal.addEventListener('abort',()=>reject(new Error('abort'))));
    const r=new Response(JSON.stringify(response),{status:options.status||200});Object.defineProperty(r,'url',{value:target});return r;
  }};
  const api={baseURL:'https://api.aidhu.net',get:async(path,config)=>{
    // Credentials are the site's responsibility; an extension reading headers would throw.
    const init={...config,method:'GET'};Object.defineProperty(init,'headers',{get(){throw new Error('credential read');}});
    const r=await window.fetch(api.baseURL+path+'?'+new URLSearchParams(config.params),init);
    const body=await r.json();if(!r.ok)throw new Error('private-token-error');return body;
  }};
  const vm={$api:api};for(const key of ['$store','token','Authorization'])Object.defineProperty(vm,key,{get(){throw new Error('credential read');}});
  const document={querySelector:selector=>selector==='#app'?{__vue__:vm}:null};Object.defineProperty(document,'cookie',{get(){throw new Error('cookie read');}});
  const c=context({window,location,document,AbortController});
  for(const file of ['main-bootstrap.js','observer.js','auto-page.js'])run(c,file);
  const request=()=>({op:'request',id:crypto.randomUUID(),kind:'one_choice',question_type:'one_choice',manual_id:'1',chapter_id:'1'});
  return {c,calls,location,api,request,set:v=>response=v,run:command=>c.DhuAutoPage.run(command)};
}
test('MAIN uses existing Vue client without reading credentials, survives SPA route changes and caches receipts',async()=>{
  const h=pageHarness();const command=h.request();h.location.href='https://aidhu.net/web/#/main/chat';
  const result=await h.run(command);assert.equal(result.ok,true);assert.equal(result.questions.length,1);
  assert.equal(JSON.stringify(result).includes('secret-marker'),false);assert.equal(h.calls.length,1);
  assert.deepEqual(plain(await h.run({...command,op:'probe'})),plain(result));assert.equal(h.calls.length,1);
  h.set({code:200,data:{1:'章一',2:'章二'}});const chapters=await h.run({...h.request(),kind:'chapters'});
  assert.equal(chapters.chapters.chapters.length,2);assert.equal(h.calls[1].params,'manual_id=1');
});
for(const status of [401,403,429])test('MAIN records HTTP '+status+' without reading exception text or credentials',async()=>{
  const h=pageHarness({status,response:{code:500,data:null}});const result=await h.run(h.request());assert.equal(result.reason,'http_'+status);assert.equal(JSON.stringify(result).includes('private-token'),false);
});
test('MAIN network error, cancellation and single-flight protection produce fixed reasons',async()=>{
  const failed=pageHarness({network:true});assert.equal((await failed.run(failed.request())).reason,'network_error');
  const h=pageHarness({hang:true}),command=h.request(),pending=h.run(command);
  assert.equal((await h.run(h.request())).reason,'page_busy');await h.run({op:'cancel',id:command.id});
  assert.equal((await pending).reason,'request_aborted');assert.equal(h.calls.length,1);
});
test('MAIN rejects arbitrary paths, origins, unsupported commands and altered client base URL',async()=>{
  const h=pageHarness();assert.equal((await h.run({...h.request(),kind:'other'})).ok,false);
  h.api.baseURL='https://evil.test';assert.equal((await h.run(h.request())).reason,'client_unavailable');
  h.location.href='https://evil.test/';assert.equal((await h.run({op:'info'})).ok,false);assert.equal(h.calls.length,0);
});

test('stop during an outstanding response is immediate and cannot launch another task',async()=>{
  const h=harness();await h.start();await h.next();let release;
  h.setRespond(()=>new Promise(resolve=>release=resolve));const pending=h.next();await new Promise(r=>setImmediate(r));
  await h.command({kind:'auto_control',action:'stop'});assert.equal(h.state.automation.status,'stopped');
  await assert.rejects(h.start({tab_id:8}));
  release({ok:true,rejected:0,questions:[row({manual_id:'1',chapter_id:'1'})]});await pending;await h.next();
  assert.equal(h.state.automation.status,'stopped');assert.equal(h.requests.length,2);assert.equal(h.state.questions.length,1);
});
test('malformed or partly rejected responses pause and never mark the task completed',async()=>{
  for(const result of [{ok:true,questions:[],rejected:1},{ok:true,questions:[row({manual_id:'2'})],rejected:0},{ok:true,questions:null,rejected:0}]){
    const h=harness();await h.start();await h.next();h.setRespond(async()=>result);await h.next();
    assert.equal(h.state.automation.status,'paused');assert.equal(h.state.queue.tasks[0].status,'pending');
  }
});
test('HTTP 200 with denied body code still pauses; empty successful arrays are valid finite observations',async()=>{
  const h=pageHarness({response:{code:403,data:[]}});assert.equal((await h.run(h.request())).reason,'http_403');
  h.set({code:200,data:[]});const result=await h.run(h.request());assert.equal(result.ok,true);assert.equal(result.questions.length,0);
  const bad=pageHarness({response:{code:200,data:[row({question:null})]}});assert.equal((await bad.run(bad.request())).rejected,1);
});

test('failed persistence of a user stop still blocks new dispatch in the running worker',async()=>{
  const h=harness();await h.start();await h.next();let release;
  h.setRespond(()=>new Promise(resolve=>release=resolve));const pending=h.next();await new Promise(r=>setImmediate(r));
  h.failSave(true);await assert.rejects(h.command({kind:'auto_control',action:'stop'}));
  h.failSave(false);release({ok:true,rejected:0,questions:[]});await pending;await h.next();
  assert.equal(h.state.automation.status,'stopped');assert.equal(h.requests.length,2);
});
