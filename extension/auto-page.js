/* MAIN world adapter: use the site's existing client, never inspect credentials. */
(() => {
  'use strict';
  if(globalThis.DhuAutoPage)return;
  const C=globalThis.DhuBankCore;
  let slot=null,dispatching=null;
  const allowedId=v=>typeof v==='string'&&/^[1-9]\d{0,15}$/.test(v);
  function client(){
    if(!C?.isAppDocument(location.href))throw new Error('page_unavailable');
    const vm=document.querySelector('#app')?.__vue__,api=vm?.$api;
    if(!api||typeof api.get!=='function'||api.baseURL!=='https://api.aidhu.net')throw new Error('client_unavailable');
    return api;
  }
  function claimFetch(input,init){
    if(!dispatching)return null;
    const url=typeof input==='string'||input instanceof URL?String(input):input instanceof Request?input.url:'';
    if(url!==dispatching.url||String(init?.method||'GET').toUpperCase()!=='GET')return null;
    const current=dispatching;dispatching=null;return current;
  }
  function clean(body,command){
    if([401,403,429].includes(Number(body?.code)))return {ok:false,reason:'http_'+Number(body.code)};
    if(!C.object(body)||body.code!==200)return {ok:false,reason:'response_shape'};
    if(command.kind==='chapters') {
      const message=C.queueMessage({marker:C.QUEUE_MARKER,version:1,event:'chapters',manual_id:command.manual_id,
        chapters:C.object(body.data)?Object.entries(body.data).map(([chapter_id,name])=>({chapter_id,name})):null});
      return {ok:true,chapters:message};
    }
    if(!Array.isArray(body.data)||body.data.length>10000)return {ok:false,reason:'response_shape'};
    const meta=C.endpoint('https://api.aidhu.net/api/protected/app/manual/chapter/questions/'+command.question_type+'?manual_id='+command.manual_id+'&chapter_id='+command.chapter_id);
    const questions=[];let rejected=0,size=0;
    for(const row of body.data){try{const q=C.filterRow(row,meta);size+=JSON.stringify(q).length;if(size>5*1024*1024)return {ok:false,reason:'response_size'};questions.push(q);}catch{rejected++;}}
    return {ok:true,questions,rejected};
  }
  async function run(command){
    if(command?.op==='info') {
      try {client();const p=new URLSearchParams(location.hash.split('?')[1]||'');return {ok:true,manual_id:allowedId(p.get('manual_id'))?p.get('manual_id'):null};}
      catch{return {ok:false,reason:'client_unavailable'};}
    }
    if(!command||typeof command.id!=='string'||!/^[-a-f0-9]{36}$/.test(command.id))return {ok:false,reason:'invalid_command'};
    if(command.op==='cancel') {if(slot?.id===command.id)slot.controller.abort();return {ok:true};}
    if(slot?.id===command.id)return slot.promise;
    // A recovered worker may read an existing receipt, but must never replay a lost request.
    if(command.op==='probe')return {ok:false,reason:'receipt_missing'};
    if(command.op!=='request'||!allowedId(command.manual_id)||!['chapters',...C.TYPES].includes(command.kind)||
      (command.kind!=='chapters'&&(!allowedId(command.chapter_id)||command.question_type!==command.kind)))return {ok:false,reason:'invalid_command'};
    if(slot&&!slot.done)return {ok:false,reason:'page_busy'};
    let api;try{api=client();}catch{return {ok:false,reason:'client_unavailable'};}
    const controller=new AbortController(),current={id:command.id,controller,done:false};slot=current;
    const path=command.kind==='chapters'?'/api/protected/app/manual/chapters':'/api/protected/app/manual/chapter/questions/'+command.kind;
    const params={manual_id:command.manual_id};if(command.kind!=='chapters')params.chapter_id=command.chapter_id;
    const request={url:'https://api.aidhu.net'+path+'?'+new URLSearchParams(params),status:null,finalURL:null};
    const timeout=setTimeout(()=>controller.abort(),20000);
    current.promise=(async()=>{
      try {
        dispatching=request;
        let pending;try{pending=api.get(path,{params,signal:controller.signal,redirect:'error',cache:'no-store'});}finally{dispatching=null;}
        const body=await pending;
        if([401,403,429].includes(request.status))return {ok:false,reason:'http_'+request.status};
        if(controller.signal.aborted)return {ok:false,reason:'request_aborted'};
        if(request.status!==200||request.finalURL!==request.url)return {ok:false,reason:'transport_unverified'};
        return clean(body,command);
      } catch {
        return {ok:false,reason:[401,403,429].includes(request.status)?'http_'+request.status:controller.signal.aborted?'request_aborted':'network_error'};
      } finally {clearTimeout(timeout);current.done=true;}
    })();
    return current.promise;
  }
  globalThis.DhuAutoPage=Object.freeze({run,claimFetch});
})();
