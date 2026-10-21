const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {context,run,plain,row,persisted}=require('./helpers.cjs');
const catalog={marker:'dhu-question-bank/queue-v1',version:1,event:'chapters',manual_id:'1',chapters:[{chapter_id:'1',name:'一'},{chapter_id:'2',name:'二'}]};
function harness(options={}){
  const c=context();['store.js','persistence.js','queue.js','auto-runner.js'].forEach(f=>run(c,f));
  const S=c.DhuBankStore,P=c.DhuPersistence,data=options.data||{},writes=[],network=[],page=new Map();let now=100000,hook=null,tail=Promise.resolve(),p,runner,answer=null;
  const serial=fn=>{const task=tail.then(fn);tail=task.catch(()=>{});return task;};
  const storage={get:async k=>({[k]:structuredClone(data[k])}),set:async values=>{
    if(hook)await hook(values);
    writes.push(plain(values));Object.assign(data,plain(values));
  },getBytesInUse:async()=>Buffer.byteLength(JSON.stringify(data))};
  function boot(){
    p=P.create(storage,{now:()=>now,timeoutMs:100});
    runner=c.DhuAutoRunner.create({now:()=>now,serial,load:()=>p.load(),save:s=>p.save(s),inherit:(a,b)=>p.inherit(a,b),
      fault:e=>p.fault(e),readReceipt:(a,r)=>p.receipt(a,r),saveReceipt:(a,r,v)=>p.receipt(a,r,v),schedule(){},
      execute:async(a,r)=>{
        if(r.op==='info')return {documentId:'document-new',result:{ok:true,manual_id:'1'}};
        if(r.op==='cancel')return {result:{ok:true}};
        if(r.op==='probe')return {result:page.get(r.id)||{ok:false,reason:'receipt_missing'}};
        network.push(plain(r));
        const result=answer?await answer(r):r.kind==='chapters'?{ok:true,chapters:catalog}:{ok:true,rejected:0,questions:r.kind==='judge'?[row({question_type:'judge',A:null,B:null,question:'判断',answer:'1'})]:[row({question_type:r.kind,answer:r.kind==='multi_choice'?'AB':'A'})]};
        page.set(r.id,result);return {result};
      }});
  }
  boot();
  const command=message=>serial(async()=>{const s=await p.load(),next=await runner.command(s,message);await p.save(next);if(['resume','recover','stop'].includes(message.action))await p.acknowledge();return next;});
  const merge=rows=>serial(async()=>{const s=await p.load(),next=await S.merge(s,rows);await p.save(next.state);return next.result;});
  return {c,S,P,data,writes,network,page,storage,serial,merge,command,boot,get p(){return p;},get runner(){return runner;},get state(){return persisted(data);},
    hook:fn=>hook=fn,respond:fn=>answer=fn,start:()=>command({kind:'auto_start',tab_id:1}),
    next:async()=>{now=Math.max(now,persisted(data)?.automation?.next_at||0);now+=5000;await runner.tick();},
    control:action=>command({kind:'auto_control',action,tab_id:1})};
}
const headWrite=v=>Object.hasOwn(v,'dhuBankHeadV2');
function failCommit(h){let once=true;h.hook(values=>{if(once&&headWrite(values)){once=false;throw new Error('QUOTA_BYTES exceeded; Authorization private-marker');}});}
async function failedQuestion(){const h=harness();await h.start();await h.next();h.respond(async()=>{failCommit(h);return {ok:true,rejected:0,questions:[row()]};});await h.next();return h;}

test('1000 sequential tasks persist progress and duplicate provenance across worker/browser restarts without full bank rewrites',async()=>{
  const h=harness();await h.start();await h.next();
  // Use the real finite queue builder (34 chapters × 3 types × 10 rounds = 1020).
  await h.control('stop');
  const chapters=Array.from({length:34},(_,i)=>({chapter_id:String(i+1),name:'章'+i}));
  h.respond(async r=>r.kind==='chapters'?{ok:true,chapters:{...catalog,chapters}}:{ok:true,rejected:0,questions:r.kind==='judge'?[row({question_type:'judge',question:'判断',A:null,B:null,answer:'1'})]:[row({question_type:r.kind,answer:r.kind==='multi_choice'?'AB':'A'})]});
  await h.command({kind:'auto_start',tab_id:1,rounds:10});await h.next();
  for(let i=0;i<1000;i++){
    if(i&&i%200===0){h.boot();h.page.clear();}
    await h.next();
    const s=h.state;assert.equal(s.queue.tasks.filter(t=>t.status==='observed').length,i+1,JSON.stringify({a:s.automation,diag:await h.p.diagnostics()}));
    assert.equal(s.questions.length,Math.min(i+1,3));
  }
  assert.equal(h.state.queue.tasks.reduce((n,t)=>n+t.duplicates,0),997);
  assert.equal(h.state.questions[0].contexts.length,34);
  assert.ok(h.writes.every(v=>!Object.hasOwn(v,'questionBankV1')));
  for(let i=1000;i<1020;i++)await h.next();
  assert.equal(h.state.automation.status,'completed');const count=h.network.length;await h.next();assert.equal(h.network.length,count);
  const fresh=h.P.create(h.storage);const restored=await fresh.load();assert.deepEqual(plain(restored.questions),h.state.questions);
  assert.equal(restored.queue.tasks.filter(t=>t.status==='observed').length,1020);
});

test('quota error is specific/redacted, cursor remains pending, durable receipt survives page/browser loss and merges once',async()=>{
  const h=await failedQuestion();
  assert.equal(h.state.questions.length,0);assert.equal(h.state.queue.tasks[0].status,'pending');assert.ok(h.state.automation.inflight);
  assert.equal((await h.p.load()).automation.status,'paused');
  const diag=await h.p.diagnostics();assert.equal(diag.last_error.code,'quota_exceeded');assert.ok(diag.pending_recovery);assert.ok(diag.usage_bytes>0);
  assert.equal(JSON.stringify(diag).includes('private-marker'),false);
  h.hook(null);h.page.clear();h.boot();await h.next();assert.equal(h.network.length,2,'blocked recovery cannot retry itself');
  await h.control('recover');await h.next();
  assert.equal(h.network.length,2,'recovery uses local journal, not the vanished page');assert.equal(h.state.questions.length,1);
  assert.equal(h.state.queue.tasks[0].status,'observed');assert.equal(h.state.automation.status,'paused');
  h.boot();await h.next();assert.equal(h.state.queue.tasks[0].added,1);assert.equal(h.state.questions.length,1);
  await h.control('resume');await h.next();assert.equal(h.network.length,3);
});

test('unavailable storage never acknowledges successful tasks, never retries indefinitely and keeps old bank',async()=>{
  const h=harness();await h.merge([row({question:'已有题'})]);await h.start();await h.next();
  h.respond(async()=>{h.hook(()=>{throw new Error('write denied');});return {ok:true,rejected:0,questions:[row()]};});
  await h.next();const before=plain(h.state);assert.equal(before.questions.length,1);assert.equal(before.queue.tasks[0].status,'pending');
  for(let i=0;i<10;i++)await h.next();assert.equal(h.network.length,2);assert.equal(h.state.automation.inflight.id,before.automation.inflight.id);
  assert.equal((await h.p.diagnostics()).last_error.code,'write_denied');
  h.hook(null);h.boot();h.page.clear();await h.next();
  assert.equal(h.state.automation.status,'paused');assert.equal(h.state.automation.last_error,'receipt_missing');assert.ok(h.state.automation.inflight);
  await assert.rejects(h.control('resume'),/恢复/);
  await h.command({kind:'auto_control',action:'resume',tab_id:1,retry_uncertain:true});
  assert.equal(h.state.automation.unresolved_requests.length,1);assert.equal(h.state.questions.length,1);
});

test('concurrent import, passive capture and automatic response share one durable transaction queue',async()=>{
  const h=harness();await h.start();await h.next();
  let release;h.respond(()=>new Promise(r=>release=r));const pending=h.next();while(!release)await new Promise(r=>setTimeout(r,1));
  await Promise.all([h.merge([row({question:'导入'})]),h.merge([row({question:'被动'})]),h.merge([row({question:'导入',source:'额外出处'})])]);
  release({ok:true,rejected:0,questions:[row({question:'自动'})]});await pending;
  const p=h.P.create(h.storage),s=await p.load();assert.deepEqual(plain(s.questions.map(q=>q.question)).sort(),['导入','自动','被动'].sort());assert.equal(s.queue.tasks[0].status,'observed');
});

test('stale snapshots and abnormal task progress are rejected instead of overwriting data',async()=>{
  const h=harness();await h.start();await h.next();await h.next();
  const stale=await h.p.load();await h.merge([row({question:'后来导入'})]);
  const changed=await h.S.merge(stale,[row({question:'陈旧写入'})]);await assert.rejects(h.p.save(changed.state),e=>e.code==='state_conflict');
  const s=await h.p.load();s.queue.tasks[0]={...s.queue.tasks[0],status:'pending'};
  await assert.rejects(h.p.save(s),e=>e.code==='state_conflict');
  assert.equal(h.state.questions.length,2);assert.equal(h.state.queue.tasks[0].status,'observed');
  const bad=await h.p.load();bad.automation.run_id='different';await assert.rejects(h.p.save(bad),e=>e.code==='state_conflict');
  const erase=await h.p.load();erase.questions=[];await assert.rejects(h.p.save(erase),e=>e.code==='state_conflict');
});

test('two persistence instances cannot publish different updates based on the same revision',async()=>{
  const h=harness();await h.merge([row()]);const other=h.P.create(h.storage);
  const old=await other.load();await h.merge([row({question:'新'})]);
  await assert.rejects(other.save((await h.S.merge(old,[row({question:'旧'})])).state),e=>e.code==='state_conflict');
  assert.equal(h.state.questions.length,2);
});

test('legacy migration verifies before switching and retains the exact old backup including answer conflicts',async()=>{
  const h=harness();const legacy=plain((await h.S.merge(h.S.empty(),[row(),row({answer:'B'}),row({A:'乙',B:'甲',answer:'B'})])).state);
  h.data.questionBankV1=structuredClone(legacy);h.boot();await h.merge([row({chapter_id:'2'})]);
  assert.deepEqual(h.data.questionBankV1,legacy);assert.equal(h.state.questions.length,3);
  assert.ok(h.data.dhuBankHeadV2);assert.ok(h.S.exportBank(await h.p.load()).report.conflict_count);
});

test('failed migration leaves legacy bank readable/exportable and never deletes any key',async()=>{
  const h=harness();const legacy=plain((await h.S.merge(h.S.empty(),[row()])).state);h.data.questionBankV1=legacy;h.boot();
  h.hook(v=>{if(headWrite(v))throw new Error('write denied');});
  await assert.rejects(h.merge([row({question:'新'})]));assert.equal(h.data.dhuBankHeadV2,undefined);assert.deepEqual(h.data.questionBankV1,legacy);
  h.boot();assert.equal((await h.p.load()).questions.length,1);assert.equal(h.S.exportBank(await h.p.load()).questions.length,1);
  h.hook(null);await h.merge([row({question:'新'})]);assert.equal(h.state.questions.length,2);assert.deepEqual(h.data.questionBankV1,legacy);
});

test('corrupted staged migration data does not switch head or remove original',async()=>{
  const h=harness();h.data.questionBankV1=plain((await h.S.merge(h.S.empty(),[row()])).state);h.boot();
  const set=h.storage.set;h.storage.set=async v=>{await set(v);for(const k of Object.keys(v))if(k.startsWith(h.P.PREFIX))h.data[k]='corrupt';};
  await assert.rejects(h.merge([row({question:'新'})]),e=>e.code==='integrity_error');assert.equal(h.data.dhuBankHeadV2,undefined);assert.equal(h.data.questionBankV1.questions.length,1);
});

for(const code of ['http_401','http_403','http_429','network_error'])test(code+' persists pause and does not advance task',async()=>{
  const h=harness();await h.start();await h.next();h.respond(async()=>({ok:false,reason:code}));await h.next();h.boot();await h.next();
  assert.equal(h.state.automation.status,'paused');assert.equal(h.state.automation.last_error,code);assert.equal(h.state.queue.tasks[0].status,'pending');assert.equal(h.network.length,2);
});

test('user stop during request remains stopped after receipt commit and worker restart',async()=>{
  const h=harness();await h.start();await h.next();let release;h.respond(()=>new Promise(r=>release=r));const pending=h.next();while(!release)await new Promise(r=>setTimeout(r,1));
  await h.control('stop');release({ok:true,rejected:0,questions:[row()]});await pending;h.boot();await h.next();
  assert.equal(h.state.automation.status,'stopped');assert.equal(h.state.questions.length,1);assert.equal(h.network.length,2);
});

test('large duplicate flood does not rewrite unchanged question blobs and export remains Python compatible',async()=>{
  const h=harness();await h.merge([row(),row({answer:'B'}),row({A:'乙',B:'甲',answer:'B'})]);const before=h.writes.length;
  const s=await h.p.load(),records=s.questions;await h.merge(Array.from({length:10000},()=>row()));
  const restored=await h.p.load();assert.equal(restored.questions,records);assert.equal(h.state.questions.length,3);
  assert.ok(h.writes.slice(before).every(v=>!Object.hasOwn(v,'questionBankV1')));
  const bank=h.S.exportBank(restored);assert.equal(bank.questions.length,3);assert.ok(bank.report.conflict_count>0);
  const py=spawnSync('python3',['-c','import json,sys;from tools.question_bank import import_documents;b=import_documents([("durable",json.load(sys.stdin))]);assert not b["report"]["rejected"];assert len(b["questions"])==3'],{input:JSON.stringify(bank),encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);
});

test('callback runtime.lastError and rejected Promise errors are classified without retaining credentials',async()=>{
  const c=context();['store.js','persistence.js'].forEach(f=>run(c,f));const P=c.DhuPersistence,runtime={};
  const p=P.create({get:(k,cb)=>cb({}),set:(v,cb)=>{runtime.lastError={message:'QUOTA_BYTES Authorization secret'};cb();delete runtime.lastError;}},{runtime});
  const s=await p.load();await assert.rejects(p.save(s),e=>e.code==='quota_exceeded'&&!e.message.includes('secret'));
});

test('serialization failure preserves committed data; timeout blocks later writes until native completion',async()=>{
  const h=harness();await h.merge([row()]);const s=await h.p.load();s.circular=s;await assert.rejects(h.p.save(s),e=>e.code==='serialization');assert.equal(h.state.questions.length,1);
  const original=h.storage.set;let release;h.storage.set=v=>new Promise(resolve=>{release=async()=>{await original(v);resolve();};});
  const p=h.P.create(h.storage,{timeoutMs:5});const next=await p.load();next.status={...next.status,last_error:'test'};
  await assert.rejects(p.save(next),e=>e.code==='storage_timeout');assert.equal((await p.diagnostics()).io_pending,true);
  const count=h.writes.length;await assert.rejects(p.save(next),e=>e.code==='storage_timeout');assert.equal(h.writes.length,count);
  await release();h.storage.set=original;await new Promise(r=>setImmediate(r));assert.equal((await p.diagnostics()).io_pending,false);
  const fresh=h.P.create(h.storage);assert.equal((await fresh.load()).questions.length,1);
});

test('journal is idempotent and refuses to overwrite an unconfirmed different receipt',async()=>{
  const h=harness();await h.start();const s=await h.p.load(),a=s.automation,r={id:'one',task_id:'t'},result={ok:true,rejected:0,questions:[row()]};
  await h.p.receipt(a,r,result);await h.p.receipt(a,r,result);await assert.rejects(h.p.receipt(a,{id:'two'},result),e=>e.code==='state_conflict');
  assert.deepEqual(plain(await h.p.receipt(a,r)),result);assert.equal(h.state.questions.length,0);
});

test('abrupt worker termination after journal flush recovers solely from durable storage',async()=>{
  const h=harness();await h.start();await h.next();
  // Snapshot the real request claim and WAL at the point before settlement.
  const s=await h.p.load(),task=s.queue.tasks[0],request={id:'crash-at-commit',kind:task.question_type,task_id:task.id,manual_id:'1',chapter_id:'1',question_type:task.question_type};
  s.automation.inflight=request;await h.p.save(s);
  await h.p.receipt(s.automation,request,{ok:true,rejected:0,questions:[row()]});
  h.boot();h.page.clear();await h.next();
  assert.equal(h.state.questions.length,1);assert.equal(h.state.queue.tasks[0].response_id,request.id);assert.equal(h.network.length,1);
  h.boot();await h.runner.tick();assert.equal(h.state.queue.tasks[0].added,1);
});

test('page refresh after worker termination before journal flush pauses with unresolved ID intact',async()=>{
  const h=harness();await h.start();await h.next();const s=await h.p.load(),task=s.queue.tasks[0];
  s.automation.inflight={id:'crash-before-journal',kind:task.question_type,task_id:task.id,manual_id:'1',chapter_id:'1'};await h.p.save(s);
  h.boot();h.page.clear();await h.next();
  assert.equal(h.state.automation.status,'paused');assert.equal(h.state.automation.inflight.id,'crash-before-journal');assert.equal(h.state.queue.tasks[0].status,'pending');assert.equal(h.network.length,1);
});

test('pause and resume survive browser recreation with exact cumulative progress and unique plan IDs',async()=>{
  const h=harness();await h.start();await h.next();await h.next();const id=h.state.automation.run_id;
  await h.control('pause');h.boot();await h.next();assert.equal(h.state.queue.tasks[0].added,1);assert.equal(h.network.length,2);
  await assert.rejects(h.start(),/已有/);await h.control('resume');await h.next();assert.equal(h.state.queue.tasks.filter(t=>t.status==='observed').length,2);assert.equal(h.state.automation.run_id,id);
  await h.control('stop');await h.start();assert.notEqual(h.state.automation.run_id,id);assert.equal(h.state.automation.previous_run_id,id);assert.equal(h.state.questions.length,2);
});

test('read-back failure after pointer publication never replays an already committed task',async()=>{
  const h=harness();await h.start();await h.next();const get=h.storage.get;let fail=false,armed=true;
  h.hook(v=>{if(armed&&headWrite(v)){
    const temp={...h.data,...plain(v)};
    if(persisted(temp).queue.tasks[0].status==='observed'){fail=true;armed=false;}
  }});
  h.storage.get=async k=>{if(fail&&k==='dhuBankHeadV2'){fail=false;throw new Error('read interrupted');}return get(k);};
  await h.next();h.boot();await h.next();assert.equal(h.state.questions.length,1);assert.equal(h.state.queue.tasks[0].added,1);assert.equal(h.network.length,2);
});

test('stopped unresolved task can be explicitly retried without discarding its receipt identity',async()=>{
  const h=harness();await h.start();await h.next();const s=await h.p.load(),task=s.queue.tasks[0];
  s.automation.inflight={id:'unconfirmed-stopped',kind:task.question_type,task_id:task.id,manual_id:'1',chapter_id:'1'};await h.p.save(s);
  await h.control('stop');h.boot();await h.next();assert.equal(h.state.automation.status,'stopped');assert.equal(h.network.length,1);
  await h.command({kind:'auto_control',action:'resume',tab_id:1,retry_uncertain:true});await h.next();
  assert.equal(h.state.queue.tasks[0].status,'observed');assert.equal(h.state.automation.unresolved_requests[0].id,'unconfirmed-stopped');
});

test('byte-limited storage rejects growth while the previous committed bank remains intact',async()=>{
  const h=harness();await h.merge([row()]);const before=plain(h.state);const limit=Buffer.byteLength(JSON.stringify(h.data))+64;
  h.hook(values=>{if(Buffer.byteLength(JSON.stringify({...h.data,...plain(values)}))>limit)throw new Error('QUOTA_BYTES exceeded');});
  await assert.rejects(h.merge([row({question:'新'.repeat(1000)})]),e=>e.code==='quota_exceeded'&&e.stage==='blob_write');
  h.boot();assert.deepEqual(plain((await h.p.load()).questions),before.questions);assert.equal(h.state.questions.length,1);
});

test('an older acknowledged fault cannot mask a new fault whose marker write failed',async()=>{
  const h=harness();await h.start();await h.p.fault(Object.assign(new Error(),{code:'quota_exceeded'}));await h.p.acknowledge();
  h.hook(()=>{throw new Error('disk full');});await h.p.fault(Object.assign(new Error(),{code:'write_denied'}));
  assert.equal((await h.p.load()).automation.status,'paused');assert.equal((await h.p.diagnostics()).last_error.code,'write_denied');assert.equal((await h.p.diagnostics()).last_error.blocking,true);
});
