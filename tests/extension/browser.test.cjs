/* Real Chromium + MV3, entirely synthetic responses fulfilled through CDP.
 * Never contacts aidhu or its API. No login/credentials required. */
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawn,spawnSync}=require('node:child_process');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {root,page,url,row}=require('./helpers.cjs');
const executable=process.env.CHROMIUM_BIN || 'chromium';
const available=spawnSync(executable,['--version'],{encoding:'utf8'}).status===0;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function waitFor(fn,label) {
  const deadline=Date.now()+12000;
  while (Date.now()<deadline) { const result=await fn(); if(result) return result; await delay(50); }
  throw new Error('Timed out: '+label);
}
async function start(profile,downloads) {
  const proc=spawn(executable,['--headless=new','--no-sandbox','--disable-dev-shm-usage','--no-first-run',
    '--disable-background-networking','--disable-component-update','--disable-sync','--disable-default-apps',
    '--enable-unsafe-extension-debugging','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0','--user-data-dir='+profile,
    '--disable-extensions-except='+root,'--load-extension='+root,'about:blank'],{stdio:['ignore','ignore','pipe']});
  let stderr='';proc.stderr.on('data',b=>{stderr+=b;});
  const wsURL=await waitFor(()=>stderr.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1], 'Chromium CDP startup').catch(error=>{proc.kill();throw new Error(error.message+'\n'+stderr.slice(-2000));});
  const socket=new WebSocket(wsURL);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
  let seq=0;const pending=new Map(),listeners=[];
  socket.onmessage=event=>{
    const message=JSON.parse(event.data);
    if (message.id) {
      const waiter=pending.get(message.id);pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));else waiter.resolve(message.result);
    } else for(const fn of listeners) fn(message);
  };
  const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
  async function target(targetURL='about:blank') {
    const {targetId}=await send('Target.createTarget',{url:targetURL});
    const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
    return sessionId;
  }
  async function evaluate(sessionId,expression) {
    const result=await send('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true},sessionId);
    if(result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  }
  async function stop() {
    try { await send('Browser.close'); } catch { proc.kill(); }
    socket.close();
    if(proc.exitCode===null && proc.signalCode===null) await new Promise(resolve=>{
      const timer=setTimeout(()=>proc.kill(),5000);
      proc.once('exit',()=>{clearTimeout(timer);resolve();});
    });
  }
  try { await send('Extensions.loadUnpacked',{path:root}); } catch (error) {
    if (/disabled by the administrator/.test(error.message)) {
      await stop(); const blocked=new Error('云端 Chromium 管理策略禁止加载未打包扩展，真实 MV3 测试未执行'); blocked.code='EXTENSION_BLOCKED'; throw blocked;
    }
    stderr+='\nCDP loadUnpacked: '+error.message;
  }
  await send('Browser.setDownloadBehavior',{behavior:'allow',downloadPath:downloads});
  return {send,target,evaluate,listeners,stop,diagnostics:()=>stderr};
}
test('real Chromium MV3: SPA fetch/XHR collection, merge, popup import/export and restart persistence', {skip:!available ? 'Chromium is not installed; real MV3 checks unrun' : false,timeout:60000}, async t => {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'dhu-extension-test-'));
  const profile=path.join(directory,'profile'),downloads=path.join(directory,'downloads');
  await fs.mkdir(downloads);
  let browser;
  try {
    browser=await start(profile,downloads);
    const service=await waitFor(async()=> (await browser.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url.endsWith('/background.js')),'extension service worker').catch(async e=>{throw new Error(e.message+'; targets='+JSON.stringify(await browser.send('Target.getTargets'))+'; stderr='+browser.diagnostics().slice(-3000));});
    const extensionOrigin='chrome-extension://'+new URL(service.url).hostname;
    const site=await browser.target();let apiRequests=0;
    browser.listeners.push(message=>{
      if(message.method!=='Fetch.requestPaused'||message.sessionId!==site)return;
      const request=message.params, u=new URL(request.request.url);
      let body='',headers=[];
      if(u.origin==='https://aidhu.net') body='<!doctype html><html><title>Synthetic fixture — no real data</title><body>Offline test fixture</body></html>';
      else if(u.origin==='https://api.aidhu.net') {
        apiRequests++;
        const type=u.pathname.split('/').pop();
        const q=type==='judge'?{question_type:'judge',question:'模拟判断',answer:'1'}:row({question_type:type,question:'模拟'+type,answer:type==='multi_choice'?'A,B':'A'});
        body=JSON.stringify({code:200,data:[q]});
        headers=[{name:'Content-Type',value:'application/json'},{name:'Access-Control-Allow-Origin',value:'https://aidhu.net'}];
      }
      void browser.send('Fetch.fulfillRequest',{requestId:request.requestId,responseCode:200,responseHeaders:headers,body:Buffer.from(body).toString('base64')},site).catch(()=>{});
    });
    await browser.send('Fetch.enable',{patterns:[{urlPattern:'*'}]},site);
    await browser.send('Page.navigate',{url:'https://aidhu.net/web/#/main/chat'},site);
    await waitFor(()=>browser.evaluate(site,"document.readyState==='complete' && location.hostname==='aidhu.net'"),'fixture load');
    const popup=await browser.target(extensionOrigin+'/popup.html');
    await waitFor(()=>browser.evaluate(popup,"typeof chrome!=='undefined' && !!document.getElementById('total')"),'popup load');
    const stats=()=>browser.evaluate(popup,"chrome.runtime.sendMessage({kind:'stats'})");
    const normalFetch=async target=>browser.evaluate(site,`fetch(${JSON.stringify(target)}).then(r=>r.json())`);
    await normalFetch(url);await delay(100);assert.equal((await stats()).stats.total,0);
    await browser.evaluate(site,`location.hash=${JSON.stringify(new URL(page).hash)}`);
    await normalFetch(url);
    await waitFor(async()=> (await stats()).stats.total===1,'first captured response');
    await normalFetch(url);await normalFetch(url.replace('one_choice','multi_choice'));
    await browser.evaluate(site,`new Promise(resolve=>{const x=new XMLHttpRequest();x.open('GET',${JSON.stringify(url.replace('one_choice','judge'))});x.onload=()=>resolve(x.status);x.send();})`);
    await waitFor(async()=> (await stats()).stats.total===3,'three types merged');
    await normalFetch(url.replace('chapter_id=1','chapter_id=2'));
    await waitFor(async()=> (await stats()).stats.total===4,'second chapter');
    // Unknown messages and a different route cannot write to the extension.
    await browser.evaluate(site,"window.postMessage({marker:'dhu-question-bank/v1',version:1,meta:{path:'/wrong'},questions:[{password:'do-not-store'}]},location.origin)");
    await browser.evaluate(site,"location.hash='/main/chat'");await normalFetch(url);await delay(100);
    assert.equal((await stats()).stats.total,4);assert.equal(apiRequests,7);
    await browser.evaluate(popup,"document.getElementById('refresh').click()");
    await waitFor(()=>browser.evaluate(popup,"document.getElementById('total').textContent==='4'"),'popup count');
    const exportResult=await browser.evaluate(popup,"chrome.runtime.sendMessage({kind:'export'})");
    assert.equal(JSON.stringify(exportResult).includes('do-not-store'),false);
    const input=path.join(directory,'import.json');await fs.writeFile(input,JSON.stringify(exportResult.bank));
    const {root:dom}=await browser.send('DOM.getDocument',{},popup);
    const {nodeId}=await browser.send('DOM.querySelector',{nodeId:dom.nodeId,selector:'#file'},popup);
    await browser.send('DOM.setFileInputFiles',{nodeId,files:[input]},popup);
    await waitFor(()=>browser.evaluate(popup,"document.getElementById('message').textContent.includes('合并 4')"),'popup JSON import');
    await browser.evaluate(popup,"document.getElementById('export').click()");
    const exported=await waitFor(async()=> (await fs.readdir(downloads)).find(n=>n.endsWith('.json')),'popup JSON download');
    const bank=JSON.parse(await fs.readFile(path.join(downloads,exported),'utf8'));
    assert.equal(bank.questions.length,4);
    const python=spawnSync('python3',['tools/question_bank.py',path.join(downloads,exported),'-o',path.join(directory,'python-export.json')],{encoding:'utf8'});
    assert.equal(python.status,0,python.stderr);
    await browser.stop();browser=null;
    browser=await start(profile,downloads);
    const popup2=await browser.target(extensionOrigin+'/popup.html');
    await waitFor(()=>browser.evaluate(popup2,"!!document.getElementById('total')"),'popup after restart');
    const persisted=await browser.evaluate(popup2,"chrome.runtime.sendMessage({kind:'stats'})");
    assert.equal(persisted.stats.total,4);
    assert.deepEqual(persisted.stats.counts,{one_choice:2,multi_choice:1,judge:1});
  } catch (error) {
    if(error.code==='EXTENSION_BLOCKED') { t.skip(error.message); return; }
    throw error;
  } finally {
    if(browser) await browser.stop();
    await fs.rm(directory,{recursive:true,force:true});
  }
});
