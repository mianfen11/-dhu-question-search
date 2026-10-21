/* MAIN world: passive observation only, with allowlisted diagnostics. */
(() => {
  'use strict';
  const boot=globalThis.__dhuMainBridgeV3;
  if(!boot)return;
  if(boot.observerInstalled){boot.announce();return;}
  const C=globalThis.DhuBankCore;
  if(!C){boot.fail('core_missing');return;}
  let originalFetch,originalOpen,hookedFetch=null,hookedOpen=null,step='observer';
  try {
  const MAX_BYTES=5*1024*1024, post=window.postMessage.bind(window);
  const current=()=>C.isPracticePage(location.href);

  const hooksReplaced=()=>Boolean((hookedFetch && window.fetch!==hookedFetch) || (hookedOpen && XMLHttpRequest.prototype.open!==hookedOpen));
  const diagnose=(event,reason,count=0)=>{
    try {post({marker:C.DIAG_MARKER,version:1,event,reason,count},'https://aidhu.net');} catch { /* Never affect page. */ }
  };
  function metadata(input,init) {
    try {
      // Never read headers, credentials, cookies or the request body.
      const method=init?.method ?? (typeof Request!=='undefined' && input instanceof Request?input.method:'GET');
      if(String(method).toUpperCase()!=='GET')return null;
      const url=typeof input==='string' || input instanceof URL?String(input):input instanceof Request?input.url:'';
      if(!C.isQuestionURL(url,location.href))return null;
      return C.endpoint(url,location.href) || {invalidContext:true};
    } catch {return null;}
  }
  function emit(meta,body) {
    if(!current())return;
    if(!body || body.code!==200 || !Array.isArray(body.data)) {diagnose('parse_error','shape');return;}
    if(body.data.length>10000) {diagnose('parse_error','size');return;}
    if(!body.data.length) {diagnose('parse_error','empty');return;}
    let batch=[],size=0,rejected=0;
    const flush=()=>{
      if(batch.length)post({marker:C.MARKER,version:1,meta,questions:batch},'https://aidhu.net');
      batch=[];size=0;
    };
    for(const row of body.data) {
      try {
        const safe=C.filterRow(row,meta),length=JSON.stringify(safe).length;
        if(length>C.MAX_MESSAGE/2){rejected++;continue;}
        if(batch.length>=C.MAX_ROWS || size+length>C.MAX_MESSAGE/2)flush();
        batch.push(safe);size+=length;
      } catch {rejected++;}
    }
    flush();
    if(rejected)diagnose('parse_error','row_schema',rejected);
  }
  async function readJSON(response) {
    const reader=response.clone().body?.getReader();
    if(!reader)throw new Error('json');
    let bytes=0;const chunks=[];
    try {
      for(;;) {
        const {done,value}=await reader.read();if(done)break;
        bytes+=value.byteLength;
        if(bytes>MAX_BYTES){void reader.cancel().catch(()=>{});throw new Error('size');}
        chunks.push(value);
      }
      const all=new Uint8Array(bytes);let offset=0;
      for(const chunk of chunks){all.set(chunk,offset);offset+=chunk.byteLength;}
      try {return JSON.parse(new TextDecoder().decode(all));}catch{throw new Error('json');}
    } finally {reader.releaseLock();}
  }
  function responseAllowed(meta,status,finalURL) {
    if(!current())return false;
    diagnose('captured','response_pending');
    if(status<200 || status>=300){diagnose('parse_error','http_status');return false;}
    if(meta.invalidContext){diagnose('parse_error','endpoint_context');return false;}
    const finalMeta=C.endpoint(finalURL,location.href);
    if(!finalMeta || C.stable(finalMeta)!==C.stable(meta)){diagnose('parse_error','redirect');return false;}
    return true;
  }
  step='fetch';originalFetch=window.fetch;
  if(typeof originalFetch==='function')window.fetch=function(input,init) {
    const meta=metadata(input,init),promise=Reflect.apply(originalFetch,this,arguments);
    if(meta)void promise.then(async response=>{
      if(!responseAllowed(meta,response.status,response.url))return;
      try {emit(meta,await readJSON(response));}
      catch(error){diagnose('parse_error',error.message==='size'?'size':'json');}
    },()=>{if(current())diagnose('parse_error','network');}).catch(()=>{if(current())diagnose('parse_error','json');});
    return promise;
  };
  if(typeof originalFetch==='function')hookedFetch=window.fetch;
  step='xhr';
  if(typeof XMLHttpRequest!=='undefined') {
    const states=new WeakMap(),open=XMLHttpRequest.prototype.open;originalOpen=open;
    XMLHttpRequest.prototype.open=function(method,url) {
      const meta=metadata(typeof url==='string' || url instanceof URL?String(url):'',{method});
      const result=Reflect.apply(open,this,arguments);
      if(!states.has(this))this.addEventListener('load',()=>{
        const active=states.get(this);
        if(!active || !responseAllowed(active,this.status,this.responseURL))return;
        try {
          if(this.responseType==='json') {
            if(JSON.stringify(this.response).length>MAX_BYTES){diagnose('parse_error','size');return;}
            emit(active,this.response);
          } else if(!this.responseType || this.responseType==='text') {
            if(this.responseText.length>MAX_BYTES){diagnose('parse_error','size');return;}
            emit(active,JSON.parse(this.responseText));
          } else diagnose('parse_error','unsupported_xhr');
        } catch {diagnose('parse_error','json');}
      });
      states.set(this,meta);return result;
    };
    hookedOpen=XMLHttpRequest.prototype.open;
  }
  boot.failure=null;boot.observerInstalled=true;boot.health=hooksReplaced;boot.announce();
  } catch {
    try {if(hookedFetch && window.fetch===hookedFetch)window.fetch=originalFetch;}catch{}
    try {if(hookedOpen && XMLHttpRequest.prototype.open===hookedOpen)XMLHttpRequest.prototype.open=originalOpen;}catch{}
    boot.fail(step==='fetch'?'fetch_patch_failed':step==='xhr'?'xhr_patch_failed':'observer_init_failed');
  }
})();
