const {test}=require('node:test');
const assert=require('node:assert/strict');
const {context,run}=require('./helpers.cjs');
const tick=()=>new Promise(r=>setTimeout(r,10));
function popup() {
  const elements={};
  for(const id of ['total','one_choice','multi_choice','judge','conflicts','saved','storage-error','export','import','refresh','file','message','diagnostic-status','diagnostic-detail','queue-manual','queue-rounds','queue-start','queue-pause','queue-resume','queue-stop','queue-status','chapter-progress','auto-start','auto-interval'])
    elements[id]={textContent:'',disabled:false,value:'',files:[],children:[],append(...items){this.children.push(...items);},replaceChildren(...items){this.children=items;},listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},click(){this.listeners.click?.();}};
  elements['queue-rounds'].value='1';elements['auto-interval'].value='5';
  const controls=[];
  let error=null, importJSON,download,diagnostic={status:'waiting',reason:'ready',captured:0,parsed:0,saved:0,rejected:0},missing=false;
  const stats={total:3,counts:{one_choice:1,multi_choice:1,judge:1},conflicts:0,last_saved_at:null,last_error:null};
  const bank={schema_version:1,questions:[],report:{}};
  const chrome={tabs:{query:async()=>[{id:7}],sendMessage:async()=>{if(missing)throw new Error('sensitive internal error');return {ok:true,diagnostic};}},runtime:{sendMessage:async message=>{
    if(error) return {ok:false,error};
    if(['queue_control','auto_start','auto_control'].includes(message.kind)){controls.push(message);return {ok:true,stats};}
    if(message.kind==='export') return {ok:true,bank};
    if(message.kind==='import'){importJSON=message.json;return {ok:true,stats,result:{added:1,duplicates:2,rejected:0,errors:[]}};}
    return {ok:true,stats};
  }},storage:{onChanged:{addListener(){}}}};
  const document={getElementById:id=>elements[id],body:{append(){}},createElement:()=>({children:[],value:'',append(...items){this.children.push(...items);},click(){download={href:this.href,name:this.download};},remove(){}})};
  const c=context({document,chrome,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout:()=>0,setInterval:()=>0});
  run(c,'popup.js');
  return {elements,c,get imported(){return importJSON;},get download(){return download;},stats,controls,fail:e=>error=e,diagnose:d=>diagnostic=d,missing:()=>missing=true};
}
test('popup displays total/type counts without rendering untrusted HTML',async()=>{
  const p=popup();await tick();
  assert.equal(p.elements.total.textContent,'3');assert.equal(p.elements.judge.textContent,'1');
  p.fail('<img src=x onerror=evil>');p.elements.refresh.click();await tick();
  assert.match(p.elements.message.textContent,/<img/);assert.equal(p.elements.message.innerHTML,undefined);
  assert.equal(p.elements.export.disabled,false);
});
test('popup imports selected JSON and reports merged counts',async()=>{
  const p=popup();await tick();
  p.elements.file.files=[{size:10,text:async()=>'{"questions":[]}'}];
  p.elements.file.listeners.change();await tick();
  assert.equal(p.imported,'{"questions":[]}');assert.match(p.elements.message.textContent,/合并 2/);
});
test('popup exports Blob download with JSON filename',async()=>{
  const p=popup();await tick();p.elements.export.click();await tick();
  assert.equal(p.download.href,'blob:test');assert.match(p.download.name,/^dhu-question-bank-.*\.json$/);
});
test('popup rejects oversized import before reading file',async()=>{
  const p=popup();await tick();
  p.elements.file.files=[{size:21*1024*1024,text:async()=>{throw new Error('must not read');}}];
  p.elements.file.listeners.change();await tick();
  assert.match(p.elements.message.textContent,/20 MB/);assert.equal(p.imported,undefined);
});

test('popup displays all five diagnostic outcomes and never renders untrusted reasons',async()=>{
  const p=popup();await tick();
  for(const [status,reason,label] of [['not_injected','observer_missing','未注入'],['waiting','ready','尚未捕获'],['parse_error','json','解析失败'],['storage_error','storage_write','存储失败'],['saved','saved','成功保存']]) {
    p.diagnose({status,reason,captured:1,parsed:1,saved:0,rejected:0});p.elements.refresh.click();await tick();
    assert.ok(p.elements['diagnostic-status'].textContent.includes(label));
  }
  p.diagnose({status:'parse_error',reason:'Cookie: private-token',url:'https://secret/'});p.elements.refresh.click();await tick();
  assert.equal(p.elements['diagnostic-detail'].textContent.includes('private-token'),false);
  p.missing();p.elements.refresh.click();await tick();
  assert.match(p.elements['diagnostic-detail'].textContent,/未找到扩展接收器/);
});

test('offline plan UI exposes statistics and controls and allows an explicitly started automatic plan',async()=>{
  const p=popup();await tick();
  p.stats.queue={status:'tracking',catalogs:[{manual_id:'1',chapters:[{chapter_id:'1',name:'章节'}]}],manual_id:'1',
    progress:{observed:1,total:6,added:2,duplicates:3,rejected:0},next:{chapter_id:'2',question_type:'judge',round:1},
    chapters:[{manual_id:'1',chapter_id:'1',name:'<img onerror=bad>',total:2,counts:{one_choice:1,multi_choice:1,judge:0}}]};
  p.elements.refresh.click();await tick();
  assert.match(p.elements['queue-status'].textContent,/新增 2，重复 3/);
  assert.equal(p.elements['queue-pause'].disabled,false);assert.equal(p.elements['auto-start'].disabled,false);
  assert.equal(p.elements['chapter-progress'].children[0].children[0].innerHTML,undefined);
  p.elements['queue-pause'].click();await tick();assert.equal(p.controls[0].action,'pause');
  p.elements.export.click();await tick();assert.match(p.download.name,/\.json$/);
});

test('popup starts automatic mode with selected limits and renders running round/error state',async()=>{
  const p=popup();await tick();p.elements['auto-start'].click();await tick();
  assert.deepEqual(JSON.parse(JSON.stringify(p.controls[0])),{kind:'auto_start',tab_id:7,manual_id:null,rounds:1,interval_seconds:5});
  p.stats.queue={status:'tracking',catalogs:[],chapters:[],progress:{observed:1,total:6,added:2,duplicates:3,rejected:0},next:{chapter_id:'2',question_type:'judge',round:1}};
  p.stats.automation={status:'running',phase:'questions',rounds:2,last_request_at:1000,last_error:'http_429',round_results:[]};
  p.stats.automation_round_added=2;
  p.elements.refresh.click();await tick();
  assert.match(p.elements['queue-status'].textContent,/自动收集中/);assert.match(p.elements['queue-status'].textContent,/本轮新增 2/);
  assert.match(p.elements['queue-status'].textContent,/429/);assert.equal(p.elements['auto-start'].disabled,true);
  p.elements['queue-pause'].click();await tick();assert.equal(p.controls[1].kind,'auto_control');assert.equal(p.controls[1].action,'pause');
  p.elements.export.click();await tick();assert.match(p.download.name,/\.json$/);
});
