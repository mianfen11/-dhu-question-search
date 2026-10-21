const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {context,run,plain,row,page,url,root}=require('./helpers.cjs');
const popupURL='chrome-extension://test-extension/popup.html';
function worker(options={}) {
  const data={};let listener,access;
  const chrome={runtime:{id:'test-extension',getURL:()=>popupURL,onMessage:{addListener:fn=>listener=fn}},
    storage:{local:{setAccessLevel:async x=>{access=x.accessLevel;if(options.failAccess)throw new Error('private-access-error');},get:async key=>{if(options.failRead)throw new Error('private-read-error');return {[key]:structuredClone(data[key])};},
      set:async value=>{await new Promise(r=>setTimeout(r,2));Object.assign(data,structuredClone(plain(value)));}}}};
  const c=context({chrome});c.importScripts=(...files)=>files.forEach(file=>run(c,file));run(c,'background.js');
  const send=(message,sender={id:'test-extension',url:popupURL})=>new Promise(resolve=>{assert.equal(listener(message,sender,resolve),true);});
  const payload={marker:c.DhuBankCore.MARKER,version:1,meta:c.DhuBankCore.endpoint(url),questions:[row()]};
  const siteSender={id:'test-extension',url:page,tab:{url:page,id:1},frameId:0};
  return {data,c,send,payload,siteSender,get access(){return access;}};
}
test('isolated bridge only accepts same-window, exact-origin validated practice batches',async () => {
  let handler;const sent=[],window={addEventListener:(name,fn)=>handler=fn};
  const location={href:page},c=context({window,location,chrome:{runtime:{sendMessage:async m=>{sent.push(plain(m));return {ok:true};}}}});
  run(c,'content.js');const data={marker:c.DhuBankCore.MARKER,version:1,meta:c.DhuBankCore.endpoint(url),questions:[row()]};
  handler({source:{},origin:'https://aidhu.net',data});
  handler({source:window,origin:'https://evil.test',data});
  handler({source:window,origin:'https://aidhu.net',data:{...data,marker:'wrong'}});
  handler({source:window,origin:'https://aidhu.net',data});
  await new Promise(r=>setTimeout(r,5));assert.equal(sent.length,1);
  location.href=page.replace('handbookAnswer','chat');handler({source:window,origin:'https://aidhu.net',data});
  assert.equal(sent.length,1);
});
test('worker serializes concurrent batches without lost writes and restricts storage access',async () => {
  const w=worker();const tasks=Array.from({length:12},(_,i)=>w.send({kind:'collect',pageHref:page,payload:{...w.payload,questions:[row({question:String(i)})]}},w.siteSender));
  const results=await Promise.all(tasks);assert.ok(results.every(r=>r.ok));
  assert.equal((await w.send({kind:'stats'})).stats.total,12);
  assert.equal(w.access,'TRUSTED_CONTEXTS');
});
test('worker rejects other sites, iframes, spoofed extension IDs and privileged page messages',async () => {
  const w=worker();
  for (const sender of [{...w.siteSender,id:'other'},{...w.siteSender,url:'https://evil.test/'},{...w.siteSender,frameId:1}]) {
    assert.equal((await w.send({kind:'collect',pageHref:page,payload:w.payload},sender)).ok,false);
  }
  assert.equal((await w.send({kind:'export'},w.siteSender)).ok,false);
  assert.equal((await w.send({kind:'import',json:'[]'},w.siteSender)).ok,false);
  assert.equal((await w.send({kind:'stats'})).stats.total,0);
});
test('worker imports/export roundtrip, invalid imports leave saved records untouched',async () => {
  const w=worker();
  assert.equal((await w.send({kind:'collect',pageHref:page,payload:w.payload},w.siteSender)).ok,true);
  const exported=await w.send({kind:'export'});
  const imported=await w.send({kind:'import',json:JSON.stringify(exported.bank)});
  assert.equal(imported.result.added,0);assert.equal(imported.result.duplicates,1);
  assert.equal((await w.send({kind:'import',json:'invalid json'})).ok,false);
  assert.equal((await w.send({kind:'stats'})).stats.total,1);
});
test('manifest grants storage only, limits scripts to target site, excludes external connections',() => {
  const m=JSON.parse(fs.readFileSync(root+'/manifest.json','utf8'));
  assert.equal(m.content_scripts[0].world,'ISOLATED');
  assert.equal(m.content_scripts[1].world,'MAIN');
  assert.equal(m.manifest_version,3);assert.deepEqual(m.permissions,['storage']);
  assert.equal(m.host_permissions,undefined);assert.equal(m.externally_connectable,undefined);
  assert.ok(m.content_scripts.every(s=>s.run_at==='document_start'&&s.matches.length===2&&s.matches[0]==='https://aidhu.net/'&&s.matches[1]==='https://aidhu.net/web/*'&&!s.all_frames));
  assert.match(m.content_security_policy.extension_pages,/connect-src 'none'/);
});
test('worker authenticates the document and live bridge route instead of the tab route snapshot',async () => {
  const w=worker(), message={kind:'collect',pageHref:page,payload:w.payload};
  const spa={...w.siteSender,url:'https://aidhu.net/web/#/main/chat'};
  assert.equal((await w.send(message,spa)).ok,true);
  const staleTab={...w.siteSender,tab:{url:'https://aidhu.net/web/#/main/chat',id:1}};
  assert.equal((await w.send(message,staleTab)).ok,true);
  assert.equal((await w.send({...message,pageHref:'https://aidhu.net/web/#/main/chat'},staleTab)).ok,false);
  assert.equal((await w.send(message,{...staleTab,url:'https://evil.test/'})).ok,false);
});
test('storage quota failure returns error and leaves existing bank intact',async () => {
  const w=worker();
  await w.send({kind:'collect',pageHref:page,payload:w.payload},w.siteSender);
  const before=JSON.stringify(w.data);
  w.c.chrome.storage.local.set=async()=>{throw new Error('QUOTA_BYTES quota exceeded');};
  const result=await w.send({kind:'import',json:JSON.stringify([row({question:'新题'})])});
  assert.equal(result.ok,false);assert.match(result.error,/存储配额/);
  assert.equal(JSON.stringify(w.data),before);
});
test('SPA collection must not be rejected by an absent or stale sender.tab.url snapshot',async () => {
  for (const tab of [{id:1},{id:1,url:'https://aidhu.net/web/'},{id:1,url:'https://aidhu.net/web/#/login'},
                     {id:1,url:'https://aidhu.net/web/#/main/chat'}]) {
    const w=worker();
    const result=await w.send({kind:'collect',pageHref:page,payload:w.payload},
      {...w.siteSender,url:'https://aidhu.net/web/#/login',tab});
    assert.equal(result.ok,true,`normal practice rejected with tab snapshot ${JSON.stringify(tab)}`);
    assert.equal((await w.send({kind:'stats'})).stats.total,1);
  }
});
test('full observer-to-storage chain saves all async types across Vue chapter changes with stale tab metadata',async () => {
  const w=worker(), handlers=[], responses=[], location={href:'https://aidhu.net/web/#/main/handbookList'};
  const originalHref='https://aidhu.net/web/#/login';
  const sender={...w.siteSender,url:originalHref,tab:{id:1,url:originalHref}};
  let requests=0;
  const window={
    addEventListener:(name,fn)=>{if(name==='message')handlers.push(fn);},
    postMessage:(data,target)=>{
      assert.equal(target,'https://aidhu.net');
      queueMicrotask(()=>handlers.forEach(fn=>fn({source:window,origin:'https://aidhu.net',data:structuredClone(plain(data))})));
    },
    fetch:target=>{
      requests++;
      const kind=new URL(target).pathname.split('/').pop();
      const item=kind==='judge'?{question_type:kind,question:'判断',answer:'1'}:
        row({question_type:kind,answer:kind==='multi_choice'?'A,B':'A'});
      const response=new Response(JSON.stringify({code:200,data:[item]}));
      Object.defineProperty(response,'url',{value:target});
      return Promise.resolve(response);
    }
  };
  const isolated=context({window,location,chrome:{runtime:{sendMessage:async message=>{
    const response=await w.send(plain(message),sender);responses.push(response);return response;
  }}}});
  run(isolated,'content.js');
  const main=context({window,location});run(main,'observer.js');
  assert.equal(requests,0);
  // This first request starts before the router writes the browser's new hash.
  const first=window.fetch(url);location.href=page;await first;
  await window.fetch(url.replace('one_choice','multi_choice'));
  await window.fetch(url.replace('one_choice','judge'));
  const waitForTotal=async expected=>{
    for(let i=0;i<100;i++) {
      const stats=(await w.send({kind:'stats'})).stats;
      if(stats.total===expected)return stats;
      await new Promise(resolve=>setTimeout(resolve,5));
    }
    assert.fail(`expected ${expected} saved questions`);
  };
  await waitForTotal(3);
  location.href=page.replace('chapter_id=1','chapter_id=2');
  for(const kind of ['one_choice','multi_choice','judge']) await window.fetch(url.replace('one_choice',kind).replace('chapter_id=1','chapter_id=2'));
  const stats=await waitForTotal(6);
  assert.deepEqual(plain(stats.counts),{one_choice:2,multi_choice:2,judge:2});
  await window.fetch(url.replace('chapter_id=1','chapter_id=2'));
  for(let i=0;i<100 && responses.length<7;i++) await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(responses.length,7);assert.equal(responses[6].result.duplicates,1);
  location.href='https://aidhu.net/web/#/main/chat';
  await window.fetch(url);
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal((await w.send({kind:'stats'})).stats.total,6);
  assert.equal(requests,8,'collector must not make any extra requests');
});

test('worker diagnoses access/read/write failure and accepts the app root without weakening sender checks',async()=>{
  for(const [options,reason] of [[{failAccess:true},'storage_access'],[{failRead:true},'storage_read']]) {
    const w=worker(options);
    const r=await w.send({kind:'collect',pageHref:page,payload:w.payload},w.siteSender);
    assert.equal(r.ok,false);assert.equal(r.stage,'storage_error');assert.equal(r.reason,reason);
    assert.equal(JSON.stringify(r).includes('private-'),false);
  }
  const w=worker();
  const r=await w.send({kind:'collect',pageHref:page.replace('/web/','/'),payload:w.payload},
    {...w.siteSender,url:'https://aidhu.net/'});
  assert.equal(r.ok,true);assert.equal(r.stats.total,1);
});
