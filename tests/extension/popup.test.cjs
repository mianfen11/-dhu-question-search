const {test}=require('node:test');
const assert=require('node:assert/strict');
const {context,run}=require('./helpers.cjs');
const tick=()=>new Promise(r=>setTimeout(r,10));
function popup() {
  const elements={};
  for(const id of ['total','one_choice','multi_choice','judge','conflicts','saved','storage-error','export','import','refresh','file','message','diagnostic-status','diagnostic-detail'])
    elements[id]={textContent:'',disabled:false,value:'',files:[],listeners:{},addEventListener(name,fn){this.listeners[name]=fn;},click(){this.listeners.click?.();}};
  let error=null, importJSON,download,diagnostic={status:'waiting',reason:'ready',captured:0,parsed:0,saved:0,rejected:0},missing=false;
  const stats={total:3,counts:{one_choice:1,multi_choice:1,judge:1},conflicts:0,last_saved_at:null,last_error:null};
  const bank={schema_version:1,questions:[],report:{}};
  const chrome={tabs:{query:async()=>[{id:7}],sendMessage:async()=>{if(missing)throw new Error('sensitive internal error');return {ok:true,diagnostic};}},runtime:{sendMessage:async message=>{
    if(error) return {ok:false,error};
    if(message.kind==='export') return {ok:true,bank};
    if(message.kind==='import'){importJSON=message.json;return {ok:true,stats,result:{added:1,duplicates:2,rejected:0,errors:[]}};}
    return {ok:true,stats};
  }},storage:{onChanged:{addListener(){}}}};
  const document={getElementById:id=>elements[id],body:{append(){}},createElement:()=>({click(){download={href:this.href,name:this.download};},remove(){}})};
  const c=context({document,chrome,Blob,URL:{createObjectURL:()=> 'blob:test',revokeObjectURL(){}},setTimeout:()=>0,setInterval:()=>0});
  run(c,'popup.js');
  return {elements,c,get imported(){return importJSON;},get download(){return download;},fail:e=>error=e,diagnose:d=>diagnostic=d,missing:()=>missing=true};
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
