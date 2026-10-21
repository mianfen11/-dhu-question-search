const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const {context,run,plain,row,page}=require('./helpers.cjs');
const popupURL='chrome-extension://auto-test/popup.html';
const wait=async condition=>{for(let i=0;i<100;i++){if(condition())return;await new Promise(r=>setTimeout(r,2));}assert.fail('coordinator did not settle');};
function environment(){
  const data={},network=[],posted=[],location={href:page,get hash(){return new URL(this.href).hash;}};let now=1000000,listener,alarmListener,worker,timers=new Map(),counter=0;
  const window={addEventListener(){},postMessage:message=>posted.push(plain(message)),fetch:async(target,init)=>{
    const u=new URL(target),kind=u.pathname.split('/').pop();network.push(u.href);
    const body={code:200,data:kind==='chapters'?{'1':'第一章','2':'第二章'}:kind==='judge'?[{question_type:'judge',question:'判断',answer:'1'}]:[row({question_type:kind,answer:kind==='multi_choice'?'AB':'A'})]};
    const response=new Response(JSON.stringify(body));Object.defineProperty(response,'url',{value:u.href});return response;
  }};
  const api={baseURL:'https://api.aidhu.net',get:async(path,opts)=>{
    const response=await window.fetch(api.baseURL+path+'?'+new URLSearchParams(opts.params),{...opts,method:'GET'});return response.json();
  }};
  const main=context({window,location,AbortController,document:{querySelector:()=>({__vue__:{$api:api}})}});
  const scripts=[],alarms=[];
  function boot(){
    timers=new Map();
    const chrome={runtime:{id:'auto-test',getURL:()=>popupURL,onMessage:{addListener:fn=>listener=fn},onStartup:{addListener(){}},onInstalled:{addListener(){}}},
      alarms:{create:(name,args)=>alarms.push({name,...plain(args)}),onAlarm:{addListener:fn=>alarmListener=fn}},
      scripting:{executeScript:async args=>{
        scripts.push(plain({target:args.target,world:args.world,files:args.files}));
        if(args.files){args.files.forEach(file=>run(main,file));return [{documentId:'doc-1'}];}
        const func=vm.runInContext('('+args.func.toString()+')',main);
        return [{documentId:'doc-1',result:plain(await func(...(args.args||[])))}];
      }},
      storage:{local:{setAccessLevel:async()=>{},get:async key=>({[key]:structuredClone(data[key])}),set:async values=>Object.assign(data,plain(values))}}};
    class Clock extends Date{static now(){return now;}}
    worker=context({chrome,Date:Clock,setTimeout:(fn,ms)=>{const id=++counter;timers.set(id,{fn,when:now+ms});return id;},clearTimeout:id=>timers.delete(id)});
    worker.importScripts=(...files)=>files.forEach(file=>run(worker,file));run(worker,'background.js');
  }
  boot();
  const send=(message,sender={id:'auto-test',url:popupURL})=>new Promise(resolve=>listener(message,sender,resolve));
  return {data,network,posted,scripts,alarms,location,send,boot,get state(){return data.questionBankV1;},
    async due(){
      const tasks=[...timers].filter(([,v])=>v.when<=now);for(const [id,t] of tasks){timers.delete(id);t.fn();}
      await new Promise(r=>setTimeout(r,3));
    },
    advance(){now=Math.max(now,data.questionBankV1.automation.next_at);},alarm(){alarmListener({name:'dhu-auto'});}};
}
test('real background integration starts only from popup, closes popup independently and executes MAIN adapter into storage',async()=>{
  const h=environment();
  assert.equal((await h.send({kind:'auto_start',tab_id:7},{id:'auto-test',url:page,frameId:0,tab:{id:7}})).ok,false);
  const result=await h.send({kind:'auto_start',tab_id:7,rounds:2,interval_seconds:5});assert.equal(result.ok,true,JSON.stringify(result));
  await h.due();await wait(()=>h.state?.automation.phase==='questions');
  assert.equal(h.network.length,1);assert.equal(h.state.queue.tasks.length,12);
  // No more popup messages; background timers and alarm wakeups perform the plan.
  for(let i=0;i<12;i++){
    h.advance();
    if(i===2){h.boot();await wait(()=>h.state.queue.tasks.filter(t=>t.status==='observed').length===i+1);}
    else {if(i===5)h.alarm();else await h.due();await wait(()=>h.state.queue.tasks.filter(t=>t.status==='observed').length===i+1);}
    h.location.href='https://aidhu.net/web/#/main/chat';
  }
  assert.equal(h.state.automation.status,'completed');assert.equal(h.network.length,13);assert.equal(h.state.questions.length,3);
  assert.deepEqual(h.state.automation.round_results,[{round:1,added:3},{round:2,added:0}]);
  assert.equal(h.posted.filter(m=>m.marker==='dhu-question-bank/v1').length,0,'automatic fetch must not also advance passive collector');
  assert.ok(h.alarms.length>0);assert.ok(h.scripts.every(s=>s.world==='MAIN'));
  assert.ok(h.scripts.some(s=>s.target.documentIds?.[0]==='doc-1'));
  const exported=await h.send({kind:'export'});assert.equal(exported.bank.questions.length,3);
  h.alarm();await h.due();assert.equal(h.network.length,13);
});
