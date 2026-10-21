const {test}=require('node:test');
const assert=require('node:assert/strict');
const {context,run,plain,row,url,page}=require('./helpers.cjs');
const c=context();run(c,'store.js');run(c,'queue.js');const C=c.DhuBankCore,Q=c.DhuQueue,S=c.DhuBankStore;
const catalog=(chapters=[{chapter_id:'1',name:'章一'},{chapter_id:'2',name:'章二'}])=>({marker:C.QUEUE_MARKER,version:1,event:'chapters',manual_id:'1',chapters});
const plan=(rounds=1)=>Q.control(Q.catalog(Q.empty(),catalog()),'start',{manual_id:'1',rounds});
const capture=(id=crypto.randomUUID(),index=0,count=1,rejected=0)=>({response_id:id,batch_index:index,batch_count:count,rejected_rows:rejected});
const result={added:1,duplicates:0,rejected:0};
test('finite queue follows observed chapter list, type and round order with no executor',()=>{
  const q=plan(2);assert.equal(q.tasks.length,12);assert.equal(q.permission,'unverified');
  assert.deepEqual(plain(q.tasks.slice(0,3).map(t=>t.question_type)),['one_choice','multi_choice','judge']);
  assert.equal(q.tasks[6].round,2);assert.equal(Q.summary({...S.empty(),queue:q}).automation_enabled,false);
  assert.throws(()=>Q.control(q,'start',{manual_id:'1',rounds:1}));
  assert.throws(()=>Q.control(Q.empty(),'start',{manual_id:'1',rounds:1}));
});
test('whole response batches complete only one task; duplicate delivery is idempotent',()=>{
  let q=plan(2),id=crypto.randomUUID(),meta=C.endpoint(url);
  q=Q.observe(q,meta,capture(id,0,2),result);assert.equal(q.tasks[0].status,'pending');
  q=Q.observe(q,meta,capture(id,0,2),result);assert.equal(q.tasks[0].added,1);
  q=Q.observe(q,meta,capture(id,1,2),{added:0,duplicates:2,rejected:0});assert.equal(q.tasks[0].status,'observed');
  q=Q.observe(q,meta,capture(id,1,2),result);
  assert.equal(q.tasks.filter(t=>t.status==='observed').length,1);assert.equal(q.tasks[6].status,'pending');
});
test('repeated random draws with no new items finish only the explicit plan, never imply completeness',()=>{
  let q=plan(2);
  for(const task of q.tasks){q=Q.observe(q,{manual_id:'1',chapter_id:task.chapter_id,question_type:task.question_type},capture(),{added:0,duplicates:75,rejected:0});}
  const stats=Q.summary({...S.empty(),queue:q});
  assert.equal(q.status,'round_finished');assert.equal(stats.completeness,'unverified');assert.equal(stats.progress.duplicates,900);
});
test('pause/resume/stop survive serialization and skip observed tasks',()=>{
  let q=Q.observe(plan(2),C.endpoint(url),capture(),result);
  q=Q.control(q,'pause');const before=JSON.stringify(q);
  assert.equal(JSON.stringify(Q.observe(q,C.endpoint(url),capture(),result)),before);
  q=Q.control(JSON.parse(before),'resume');q=Q.observe(q,C.endpoint(url),capture(),result);
  assert.equal(q.tasks[0].added,1);assert.equal(q.tasks[6].status,'observed');
  q=Q.control(q,'stop');assert.equal(q.tasks[0].status,'observed');assert.throws(()=>Q.control(q,'resume'));
});
test('interrupted response is replaced by a new normal response without losing pending work',()=>{
  let q=plan(),meta=C.endpoint(url),old=crypto.randomUUID();
  q=Q.observe(q,meta,capture(old,0,2),result);q=JSON.parse(JSON.stringify(q));
  q=Q.observe(q,meta,capture(),result);assert.equal(q.tasks[0].status,'observed');
  const after=JSON.stringify(q);assert.equal(JSON.stringify(Q.observe(q,meta,capture(old,1,2),result)),after);
});
test('normalization failures and dropped MAIN rows keep a task pending for review',()=>{
  let q=plan(),meta=C.endpoint(url);
  q=Q.observe(q,meta,capture(),{added:0,duplicates:0,rejected:1});assert.equal(q.tasks[0].status,'pending');
  q=Q.observe(q,meta,capture(undefined,0,1,2),result);assert.equal(q.tasks[0].status,'pending');
  assert.equal(q.tasks[0].rejected,3);
});
test('401/403/429 persist a pause; continuing is an explicit offline operation',()=>{
  for(const code of [401,403,429]){
    let q=Q.blocked(plan(),code);assert.equal(q.status,'paused');assert.equal(q.pause_reason,'http_'+code);
    q=JSON.parse(JSON.stringify(q));assert.equal(Q.control(q,'resume').status,'tracking');
  }
});
test('chapter statistics include zero-count catalog chapters and existing bank data; imports preserve the plan',async()=>{
  let bank={...S.empty(),queue:plan()};bank=(await S.merge(bank,[row({manual_id:'1',chapter_id:'1'})])).state;
  const summary=Q.summary(bank);assert.equal(summary.chapters.length,2);assert.equal(summary.chapters[0].total,1);assert.equal(summary.chapters[1].total,0);
  assert.equal(summary.progress.observed,0);assert.equal(bank.queue.tasks.length,6);
});
test('catalog and capture messages reject foreign paths, oversized fields and injected control commands',()=>{
  assert.equal(C.chapterEndpoint('https://api.aidhu.net/api/protected/app/manual/chapters?manual_id=1').manual_id,'1');
  assert.equal(C.chapterEndpoint('https://evil.test/api/protected/app/manual/chapters?manual_id=1'),null);
  assert.throws(()=>C.queueMessage({...catalog(),token:'private'}));
  assert.throws(()=>C.queueMessage({...catalog(),event:'start'}));
  assert.throws(()=>C.queueMessage(catalog([{chapter_id:'1',name:'x'.repeat(201)}])));
  assert.throws(()=>C.captureInfo({...capture(),Authorization:'private'}));
});
test('passive observer captures normal chapter-list and guard events without adding requests',async()=>{
  const posts=[],listeners=[],location={href:'https://aidhu.net/web/#/main/handbookList'};
  const chapterURL='https://api.aidhu.net/api/protected/app/manual/chapters?manual_id=1';
  let requested=0,status=200,body={code:200,data:{'1':'第一章','2':'第二章'}};
  const window={addEventListener:(name,fn)=>listeners.push(fn),postMessage:data=>posts.push(plain(data)),fetch:target=>{
    requested++;const response=new Response(JSON.stringify(body),{status});Object.defineProperty(response,'url',{value:target});return Promise.resolve(response);
  }};
  const vm=context({window,location});run(vm,'main-bootstrap.js');run(vm,'observer.js');
  assert.equal(requested,0);await window.fetch(chapterURL);await new Promise(r=>setTimeout(r,25));
  assert.equal(posts.find(p=>p.event==='chapters').chapters.length,2);
  status=429;body={code:429};await window.fetch(chapterURL);await new Promise(r=>setTimeout(r,25));
  assert.equal(posts.find(p=>p.event==='blocked').status,429);assert.equal(requested,2);
  location.href=page;status=200;body={code:200,data:[]};await window.fetch(url);await new Promise(r=>setTimeout(r,25));
  const empty=posts.find(p=>p.event==='empty');assert.equal(C.queueMessage(empty).meta.question_type,'one_choice');
});
