const {test}=require('node:test');
const assert=require('node:assert/strict');
const {context,run,plain,row,page,url}=require('./helpers.cjs');
const tick=()=>new Promise(r=>setTimeout(r,20));
const popupSender={id:'test-extension',url:'chrome-extension://test-extension/popup.html'};
function bridge({reply,ready=false,href=page}={}) {
  const listeners=[],sent=[];let receiver;
  const window={addEventListener:(name,fn)=>listeners.push(fn),postMessage:data=>{
    if(ready && data.event==='probe')queueMicrotask(()=>emit(diag('ready','ready')));
  }};
  const chrome={runtime:{id:popupSender.id,getURL:()=>popupSender.url,onMessage:{addListener:fn=>receiver=fn},
    sendMessage:async message=>{sent.push(plain(message));return reply?reply(message):{ok:true,result:{added:1,duplicates:0,rejected:0}};}}};
  const c=context({window,location:{href},chrome,setTimeout:(fn,ms)=>setTimeout(fn,Math.min(ms,5))});
  run(c,'content.js');
  function diag(event,reason,count=0){return {marker:c.DhuBankCore.DIAG_MARKER,version:1,event,reason,count};}
  function emit(data,origin='https://aidhu.net',source=window){listeners.forEach(fn=>fn({source,origin,data}));}
  const data=()=>({marker:c.DhuBankCore.MARKER,version:1,meta:c.DhuBankCore.endpoint(url),questions:[row()]});
  const status=()=>new Promise(resolve=>assert.equal(receiver({kind:'diagnose'},popupSender,resolve),true));
  return {c,emit,diag,data,status,sent,receiver};
}
test('diagnostics distinguish missing MAIN injection from a live listener without responses',async()=>{
  const missing=bridge();
  assert.equal((await missing.status()).diagnostic.status,'not_injected');
  const live=bridge({ready:true});
  const d=(await live.status()).diagnostic;
  assert.equal(d.status,'waiting');assert.equal(d.observerReady,true);assert.equal(d.captured,0);
});
test('captured malformed response is parse_error rather than silently zero',async()=>{
  const h=bridge({ready:true});h.emit(h.diag('captured','response_pending'));h.emit(h.diag('parse_error','json'));
  const d=(await h.status()).diagnostic;
  assert.equal(d.status,'parse_error');assert.equal(d.reason,'json');assert.equal(d.captured,1);assert.equal(d.saved,0);
  assert.equal(h.sent.length,0);
  h.emit(h.diag('parse_error','network'));
  assert.equal((await h.status()).diagnostic.status,'waiting');
  h.emit(h.diag('parse_error','empty'));
  assert.equal((await h.status()).diagnostic.status,'captured');
});
test('background write failure and unreachable runtime are visible without raw exception details',async()=>{
  for(const reply of [()=>({ok:false,stage:'storage_error',reason:'storage_write',error:'secret-must-not-leak'}),()=>{throw new Error('Authorization: secret-must-not-leak');}]) {
    const h=bridge({ready:true,reply});h.emit(h.data());await tick();
    const d=(await h.status()).diagnostic;
    assert.equal(d.status,'storage_error');assert.equal(d.parsed,1);assert.equal(d.saved,0);
    assert.equal(JSON.stringify(d).includes('secret'),false);
  }
});
test('all rows rejected by normalization is parse_error, not successful save',async()=>{
  const h=bridge({ready:true,reply:()=>({ok:true,result:{added:0,duplicates:0,rejected:1}})});
  h.emit(h.data());await tick();const d=(await h.status()).diagnostic;
  assert.equal(d.status,'parse_error');assert.equal(d.reason,'normalization');
});
test('only successful background acknowledgment produces saved status, including duplicates',async()=>{
  let calls=0;
  const h=bridge({ready:true,reply:()=>({ok:true,result:{added:calls++===0?1:0,duplicates:calls===1?0:1,rejected:0}})});
  h.emit(h.data());await tick();h.emit(h.data());await tick();
  const d=(await h.status()).diagnostic;
  assert.equal(d.status,'saved');assert.equal(d.saved,2);assert.equal(d.parsed,2);
  assert.equal(JSON.stringify(d).includes('模拟题'),false);
});
test('diagnostic payloads and senders are allowlisted and never echo tokens or URLs',async()=>{
  const h=bridge({ready:true});
  h.emit({...h.diag('parse_error','json'),Cookie:'secret-cookie'});
  h.emit(h.diag('parse_error','Authorization: secret-token'));
  h.emit(h.diag('parse_error','json'),'https://evil.test');
  h.emit(h.diag('parse_error','json'),'https://aidhu.net',{});
  assert.equal(h.receiver({kind:'diagnose'},{id:'wrong',url:popupSender.url},()=>assert.fail()),undefined);
  const d=(await h.status()).diagnostic;
  assert.equal(d.status,'waiting');
  for(const secret of ['Cookie','Authorization','secret','https://','模拟题'])assert.equal(JSON.stringify(d).includes(secret),false);
});
test('MAIN observer implementation reports fetch/XHR parse errors and supports startup handshake',async()=>{
  const posts=[],listeners=[],location={href:page};let payload='{not JSON',target=url;
  class XHR {
    addEventListener(name,fn){this.load=fn;}
    open(method,u){this.responseURL=u;}
  }
  const window={postMessage:data=>posts.push(plain(data)),addEventListener:(name,fn)=>listeners.push(fn),fetch:()=>{
    const response=new Response(payload);Object.defineProperty(response,'url',{value:target});return Promise.resolve(response);
  }};
  const c=context({window,location,XMLHttpRequest:XHR});run(c,'observer.js');
  assert.equal(posts[0].event,'ready');
  listeners[0]({source:window,origin:'https://aidhu.net',data:{marker:c.DhuBankCore.DIAG_MARKER,version:1,event:'probe',reason:'none',count:0}});
  assert.equal(posts.at(-1).event,'ready');
  await window.fetch(url);await tick();assert.equal(posts.at(-1).reason,'json');
  payload=JSON.stringify({code:200,data:{not:'array'}});await window.fetch(url);await tick();assert.equal(posts.at(-1).reason,'shape');
  payload=JSON.stringify({code:200,data:[{question:'missing fields',source:{token:'never-forward'}}]});
  await window.fetch(url);await tick();
  // The worker performs final normalization; observer still projects only known scalar fields.
  assert.ok(posts.some(p=>p.reason==='row_schema'));
  const xhr=new XHR();xhr.open('GET',url);xhr.status=200;xhr.responseType='text';xhr.responseText='bad json';xhr.load();
  assert.equal(posts.at(-1).reason,'json');
  target=url.replace('api.aidhu.net','evil.test');await window.fetch(url);await tick();assert.equal(posts.at(-1).reason,'redirect');
  target=url;await window.fetch(url.replace('chapter_id=1','chapter_id=0'));await tick();assert.equal(posts.at(-1).reason,'endpoint_context');
  assert.equal(JSON.stringify(posts).includes('never-forward'),false);
});
test('root and /web entry points are accepted without accepting other sites or paths',()=>{
  const C=context().DhuBankCore;
  assert.equal(C.isPracticePage(page.replace('/web/','/')),true);
  assert.equal(C.isPracticePage(page),true);
  assert.equal(C.isPracticePage(page.replace('/web/','/other/')),false);
  assert.equal(C.isPracticePage(page.replace('aidhu.net','aidhu.net.evil.test')),false);
  assert.equal(C.isQuestionURL(url),true);
  for(const bad of [url.replace('https:','http:'),url.replace('api.aidhu.net','aidhu.net'),url.replace('one_choice','unknown')])assert.equal(C.isQuestionURL(bad),false);
});

test('MAIN handshake detects a page replacing the installed fetch wrapper',()=>{
  const posts=[],listeners=[],window={fetch:()=>Promise.resolve(),postMessage:d=>posts.push(plain(d)),addEventListener:(name,fn)=>listeners.push(fn)};
  const c=context({window,location:{href:page}});run(c,'observer.js');
  window.fetch=()=>Promise.resolve();
  listeners[0]({source:window,origin:'https://aidhu.net',data:{marker:c.DhuBankCore.DIAG_MARKER,version:1,event:'probe',reason:'none',count:0}});
  assert.equal(posts.at(-1).reason,'hook_replaced');
});
test('ok without an explicit row-write acknowledgment does not claim successful saving',async()=>{
  const h=bridge({ready:true,reply:()=>({ok:true})});h.emit(h.data());await tick();
  assert.equal((await h.status()).diagnostic.status,'storage_error');
});
