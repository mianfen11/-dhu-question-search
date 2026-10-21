const {test}=require('node:test');
const assert=require('node:assert/strict');
const {context,run,plain,row,page,url}=require('./helpers.cjs');
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
function harness() {
  const messages=[], requests=[];
  let nextBody={code:200,data:[row()]}, status=200, finalURL=url, reject=false;
  const location={href:page};
  class XHR {
    constructor(){this.events={};this.responseType='';}
    addEventListener(name,fn){(this.events[name]??=[]).push(fn);}
    open(method,target){this.method=method;this.target=target;}
    complete(body,{responseType='',responseURL=this.target,status=200}={}) {
      this.responseType=responseType;this.responseURL=responseURL;this.status=status;
      this.response=body;this.responseText=typeof body==='string'?body:JSON.stringify(body);
      for (const listener of this.events.load||[]) listener();
    }
  }
  const window={postMessage:(data,origin)=>messages.push({data:plain(data),origin}),
    fetch:(...args)=> {
      requests.push(args);
      if (reject) return Promise.reject(new Error('network error'));
      const response=new Response(typeof nextBody==='string'?nextBody:JSON.stringify(nextBody),{status});
      Object.defineProperty(response,'url',{value:finalURL});
      return Promise.resolve(response);
    }};
  const c=context({window,location,XMLHttpRequest:XHR}); run(c,'observer.js');
  return {c,window,location,XHR,messages,requests,set:(body,opts={})=>{nextBody=body;status=opts.status??200;finalURL=opts.finalURL??url;reject=opts.reject??false;}};
}
test('fetch is passive, original response readable and repeated install safe',async () => {
  const h=harness(); assert.equal(h.requests.length,0);
  const response=await h.window.fetch(url);
  assert.equal((await response.json()).data[0].question,'模拟题');
  await tick();assert.equal(h.messages.length,1);assert.equal(h.requests.length,1);
  run(h.c,'observer.js'); await h.window.fetch(url); await tick();
  assert.equal(h.messages.length,2);
});
test('SPA outside to practice to outside: observe only normal practice responses',async () => {
  const h=harness();h.location.href='https://aidhu.net/web/#/main/chat';
  await h.window.fetch(url);await tick();assert.equal(h.messages.length,0);
  h.location.href=page;
  await h.window.fetch(url);await tick();assert.equal(h.messages.length,1);
  h.location.href=page.replace('mode=practice','mode=exam');
  await h.window.fetch(url);await tick();assert.equal(h.messages.length,1);
});
test('no other origins, paths, methods, redirects, malformed or failed responses collected',async () => {
  const h=harness();
  await h.window.fetch(url.replace('api.aidhu.net','evil.test'));
  await h.window.fetch(url.replace('one_choice','exam_question'));
  await h.window.fetch(url,{method:'POST'});
  h.set('invalid json');await h.window.fetch(url);
  h.set({code:401,data:[row()]});await h.window.fetch(url);
  h.set({code:200,data:[row()]},{status:401});await h.window.fetch(url);
  h.set({code:200,data:[row()]},{finalURL:url.replace('api.aidhu.net','evil.test')});await h.window.fetch(url);
  h.set(null,{reject:true});await assert.rejects(h.window.fetch(url));
  await tick();assert.equal(h.messages.length,0);
});
test('never reads request authentication headers or forwards unknown fields',async () => {
  const h=harness();const init={get headers(){throw new Error('headers must not be read');}};
  h.set({code:200,data:[row({Authorization:'credential-marker',Cookie:'credential-marker'})]});
  await h.window.fetch(url,init);await tick();
  assert.equal(h.messages.length,1);
  assert.equal(JSON.stringify(h.messages).includes('credential-marker'),false);
});
test('XHR text/json, reuse and malformed replies preserve application behavior',() => {
  const h=harness(), xhr=new h.XHR();
  xhr.open('GET',url);xhr.complete({code:200,data:[row()]});
  xhr.open('GET',url);xhr.complete({code:200,data:[row({question:'第二题'})]},{responseType:'json'});
  assert.equal(h.messages.length,2);
  xhr.open('GET',url);xhr.complete('invalid json');
  xhr.open('GET',url.replace('api.aidhu.net','evil.test'));xhr.complete({code:200,data:[row()]});
  xhr.open('GET',url);xhr.complete({code:200,data:[row()]},{status:500});
  assert.equal(h.messages.length,2);
});
test('bad rows skipped individually and large batches are safely split',async () => {
  const h=harness();h.set({code:200,data:[row({question:null}),...Array.from({length:205},(_,i)=>row({question:String(i)}))]});
  await h.window.fetch(url);await tick();
  assert.deepEqual(h.messages.map(m=>m.data.questions.length),[100,100,5]);
});
test('fetch started during SPA navigation is collected after practice hash becomes current',async () => {
  const h=harness();h.location.href='https://aidhu.net/web/#/main/handbookList';
  const response=h.window.fetch(url);
  h.location.href=page;
  assert.equal((await (await response).json()).data.length,1);
  await tick();assert.equal(h.messages.length,1);
});
test('XHR opened before practice hash update is collected when its async response arrives',() => {
  const h=harness();h.location.href='https://aidhu.net/web/#/main/handbookList';
  const xhr=new h.XHR();xhr.open('GET',url);
  h.location.href=page;xhr.complete({code:200,data:[row()]});
  assert.equal(h.messages.length,1);
});
