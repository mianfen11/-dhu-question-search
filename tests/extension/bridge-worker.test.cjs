const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const {context,run,plain,row,page,url,root}=require('./helpers.cjs');
const popupURL='chrome-extension://test-extension/popup.html';
function worker() {
  const data={};let listener,access;
  const chrome={runtime:{id:'test-extension',getURL:()=>popupURL,onMessage:{addListener:fn=>listener=fn}},
    storage:{local:{setAccessLevel:async x=>{access=x.accessLevel;},get:async key=>({[key]:structuredClone(data[key])}),
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
  assert.equal(m.manifest_version,3);assert.deepEqual(m.permissions,['storage']);
  assert.equal(m.host_permissions,undefined);assert.equal(m.externally_connectable,undefined);
  assert.ok(m.content_scripts.every(s=>s.run_at==='document_start'&&s.matches.length===1&&s.matches[0]==='https://aidhu.net/web/*'&&!s.all_frames));
  assert.match(m.content_security_policy.extension_pages,/connect-src 'none'/);
});
test('worker accepts SPA entry from an initially non-practice document but rejects current non-practice tab',async () => {
  const w=worker(), message={kind:'collect',pageHref:page,payload:w.payload};
  const spa={...w.siteSender,url:'https://aidhu.net/web/#/main/chat'};
  assert.equal((await w.send(message,spa)).ok,true);
  const outside={...w.siteSender,tab:{url:'https://aidhu.net/web/#/main/chat',id:1}};
  assert.equal((await w.send(message,outside)).ok,false);
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
