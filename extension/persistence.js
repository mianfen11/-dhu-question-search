/* Verified, immutable blobs + one commit pointer. Legacy data is NEVER removed.
 * All read/modify/write transactions are serialized by background.js; Web Locks
 * also protect commit publication between extension contexts. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore,S=globalThis.DhuBankStore;
  const REV=Symbol.for('dhu.persist.revision');
  const HEAD='dhuBankHeadV2',FAULT='dhuStorageFaultV2',RECEIPT='dhuPendingReceiptV2',PREFIX='dhuBlobV2:';
  const labels={quota_exceeded:'存储容量不足',serialization:'数据序列化失败',write_denied:'存储写入被拒绝',
    storage_timeout:'存储操作超时，结果待确认',state_conflict:'任务或存储版本冲突',integrity_error:'持久化数据完整性校验失败',
    read_failed:'存储读取失败',unknown_storage:'未知存储异常',migration_failed:'旧数据迁移校验失败',task_processing:'任务数据处理失败'};
  function error(code,stage){const e=new Error(labels[code]||labels.unknown_storage);e.code=code;e.stage=stage;return e;}
  function classify(e,stage='write'){
    if(e?.code&&Object.hasOwn(labels,e.code))return {code:e.code,stage:e.stage||stage};
    const s=String(e?.message||'');
    return {code:/quota|QUOTA_BYTES|disk.*full|no space/i.test(s)?'quota_exceeded':/serializ|cyclic|circular|clone/i.test(s)?'serialization':
      /denied|permission|not allowed|access/i.test(s)?'write_denied':stage==='read'?'read_failed':'unknown_storage',stage};
  }
  function stringify(value){
    try{return JSON.stringify(value,(_,v)=>{if(typeof v==='function'||typeof v==='symbol'||typeof v==='bigint'||typeof v==='number'&&!Number.isFinite(v))throw Error();return v;});}
    catch{throw error('serialization','serialize');}
  }
  async function hash(text){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');}
  function freeze(v){if(v&&typeof v==='object'&&!Object.isFrozen(v)){Object.values(v).forEach(freeze);Object.freeze(v);}return v;}
  function create(storage,options={}){
    const runtime=options.runtime,now=options.now||(()=>Date.now()),timeout=options.timeoutMs||15000;
    let cache=null,cacheHead=null,lastFault=null,lastCommit=null,blockedIO=null,legacyRetained=null;
    const known=new Set(),objectRefs=new WeakMap(),revisions=new WeakMap(),listCache=new WeakMap();
    const lock=fn=>options.lock?options.lock(fn):globalThis.navigator?.locks?globalThis.navigator.locks.request('dhu-bank-v2-commit',fn):fn();
    function call(method,...args){
      if(typeof storage[method]!=='function')return Promise.reject(error('unknown_storage',method));
      let settled=false;
      const native=new Promise((resolve,reject)=>{
        const done=(err,value)=>{if(settled)return;settled=true;err?reject(err):resolve(value);};
        try{
          const p=storage[method](...args,value=>{const e=runtime?.lastError;done(e?new Error(String(e.message||'')):null,value);});
          if(p?.then)p.then(value=>done(null,value),e=>done(e));
        }catch(e){done(e);}
      });
      let timer;
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{if(method==='set')blockedIO=native;reject(error('storage_timeout',method.startsWith('get')?'read':'write'));},timeout);});
      native.then(()=>{if(blockedIO===native)blockedIO=null;},()=>{if(blockedIO===native)blockedIO=null;});
      return Promise.race([native,deadline]).catch(e=>{const c=classify(e,method==='get'?'read':'write');throw error(c.code,c.stage);}).finally(()=>clearTimeout(timer));
    }
    async function get(key){try{return (await call('get',key))[key];}catch(e){e.stage=key===HEAD?'head_read':key===RECEIPT?'receipt_read':key===S.KEY?'legacy_read':'read';throw e;}}
    async function put(values){
      const key=Object.keys(values)[0],stage=key===HEAD?'commit_pointer':key===RECEIPT?'receipt_pointer':key.startsWith(RECEIPT+':')?'receipt_chunk':key===FAULT?'fault_marker':'blob_write';
      if(blockedIO)throw error('storage_timeout',stage);
      try{await call('set',values);}catch(e){e.stage=stage;throw e;}
    }
    async function blob(value){
      if(value&&typeof value==='object'&&Object.isFrozen(value)&&objectRefs.has(value))return objectRefs.get(value);
      const text=stringify(value);if(text===undefined)throw error('serialization','serialize');
      const id=await hash(text),key=PREFIX+id;
      if(!known.has(id)){
        const existing=await get(key);
        if(existing===undefined){
          if(text.length<=30000)await put({[key]:text});
          else{
            const parts=[];
            for(let i=0;i<text.length;i+=30000){const piece=text.slice(i,i+30000),part=await hash(JSON.stringify(piece));const k=PREFIX+'part:'+part;
              if(await get(k)===undefined)await put({[k]:piece});
              if(await get(k)!==piece)throw error('integrity_error','verify');parts.push(part);}
            await put({[key]:{parts}});
          }
        }
        const restored=await readText(id);
        if(restored!==text)throw error('integrity_error','verify');known.add(id);
      }
      if(value&&typeof value==='object'&&Object.isFrozen(value))objectRefs.set(value,id);return id;
    }
    async function readText(id){
      if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw error('integrity_error','read');
      const value=await get(PREFIX+id);let text;
      if(typeof value==='string')text=value;
      else if(C.object(value)&&Array.isArray(value.parts)){
        const pieces=[];for(const part of value.parts){const piece=await get(PREFIX+'part:'+part);
          if(typeof piece!=='string'||await hash(JSON.stringify(piece))!==part)throw error('integrity_error','read');pieces.push(piece);}text=pieces.join('');
      }else throw error('integrity_error','read');
      if(await hash(text)!==id)throw error('integrity_error','read');return text;
    }
    async function readBlob(id){let value;try{value=JSON.parse(await readText(id));}catch(e){throw e.code?e:error('integrity_error','read');}
      if(value&&typeof value==='object')objectRefs.set(value,id);known.add(id);return value;}
    async function list(values){
      if(Object.isFrozen(values)&&listCache.has(values))return listCache.get(values);
      const refs=[];for(const value of values)refs.push(await blob(value));
      const pages=[];for(let i=0;i<refs.length;i+=64)pages.push(await blob(refs.slice(i,i+64)));
      listCache.set(values,pages);return pages;
    }
    async function readList(pages,count){
      if(!Array.isArray(pages)||!Number.isInteger(count)||count<0)throw error('integrity_error','read');
      const values=[];for(const page of pages){const refs=await readBlob(page);if(!Array.isArray(refs)||refs.length>64)throw error('integrity_error','read');for(const ref of refs)values.push(await readBlob(ref));}
      if(values.length!==count)throw error('integrity_error','read');listCache.set(values,pages);return values;
    }
    async function encode(state,revision){
      const parts={};for(const [k,v]of Object.entries(state))if(!['questions','queue'].includes(k))parts[k]=await blob(v);
      if(state.queue){const {tasks,catalogs,...base}=state.queue;parts.queue=await blob(base);parts.catalogs=await blob(catalogs);}
      return {version:2,revision,receipt_confirmed:state.automation?.last_committed_request||cacheHead?.receipt_confirmed||null,committed_at:now(),commit_id:crypto.randomUUID(),question_count:state.questions.length,task_count:state.queue?.tasks.length||0,
        questions:await list(state.questions),tasks:await list(state.queue?.tasks||[]),parts};
    }
    async function decode(head){
      if(!C.object(head)||head.version!==2||!Number.isSafeInteger(head.revision)||head.revision<1||!C.object(head.parts))throw error('integrity_error','read');
      const state={};for(const [k,ref]of Object.entries(head.parts))if(!['queue','catalogs'].includes(k))state[k]=await readBlob(ref);
      state.questions=await readList(head.questions,head.question_count);
      if(head.parts.queue)state.queue={...await readBlob(head.parts.queue),catalogs:await readBlob(head.parts.catalogs),tasks:await readList(head.tasks,head.task_count)};
      if(state.schema_version!==1||!C.object(state.status))throw error('integrity_error','read');return state;
    }
    function remember(state,head){cache=state;cacheHead=head;freeze(cache.questions);if(cache.queue)freeze(cache.queue.tasks);}
    function view(){const {questions,queue,...meta}=cache;const state={...structuredClone(meta),questions};if(queue){const {tasks,...header}=queue;state.queue={...structuredClone(header),tasks:tasks.slice()};}state[REV]=cacheHead?.revision||0;revisions.set(state,state[REV]);return state;}
    function committed(receipt,state){return !receipt||receipt.completed||cacheHead?.receipt_confirmed===receipt.request_id||state.automation?.last_committed_request===receipt.request_id||
      state.queue?.tasks.some(t=>t.status==='observed'&&t.response_id===receipt.request_id);}
    async function load(){
      const head=await get(HEAD);
      if(!cache||JSON.stringify(head)!==JSON.stringify(cacheHead)){
        if(head){remember(await decode(head),head);if(legacyRetained===null)legacyRetained=storage.getBytesInUse?await call('getBytesInUse',S.KEY)>0:Boolean(await get(S.KEY));}
        else{const legacy=await get(S.KEY);legacyRetained=legacy!=null;if(legacy!=null&&(!C.object(legacy)||legacy.schema_version!==1||!Array.isArray(legacy.questions)||!C.object(legacy.status)))throw error('integrity_error','legacy_read');remember(legacy||S.empty(),undefined);}
      }
      const storedFault=await get(FAULT);if(!lastFault||storedFault?.time>lastFault.time)lastFault=storedFault||lastFault;
      const state=view(),a=state.automation;
      if(lastFault?.blocking&&a){if(a.status==='running')a.status='paused';if(state.queue?.status==='tracking')state.queue.status='paused';
        const receipt=await get(RECEIPT);a.recovery={...(a.recovery||{}),blocked:true,error:lastFault.code,has_receipt:Boolean(receipt&&!committed(receipt,state)&&receipt.run_id===a.run_id&&receipt.request_id===a.inflight?.id)};a.last_error=lastFault.code;}
      return state;
    }
    function guard(state){
      if(!C.object(state)||state.schema_version!==1||!Array.isArray(state.questions)||!C.object(state.status))throw error('serialization','state');
      const old=cache?.automation,a=state.automation;
      if(old?.run_id&&a?.run_id!==old.run_id&&(old.inflight||['running','paused'].includes(old.status)))throw error('state_conflict','run_replaced');
      if(old?.run_id&&a?.run_id===old.run_id){
        if(old.phase==='questions'&&(a.phase!=='questions'||a.rounds!==old.rounds||a.manual_id!==old.manual_id))throw error('state_conflict','plan_changed');
        if((state.queue?.tasks||[]).some(t=>!['pending','observed'].includes(t.status)||['added','duplicates','rejected'].some(k=>!Number.isSafeInteger(t[k])||t[k]<0)))throw error('state_conflict','task_stats');
      }
      if(old?.run_id&&a?.run_id===old.run_id&&cache.queue?.tasks.length){
        const tasks=new Map((state.queue?.tasks||[]).map(t=>[t.id,t]));
        for(const t of cache.queue.tasks){const next=tasks.get(t.id);
          if(!next||t.status==='observed'&&(next.status!=='observed'||next.response_id!==t.response_id)||['added','duplicates','rejected'].some(k=>next[k]<t[k]))throw error('state_conflict','progress');}
      }
      if(cache?.questions?.length&&state.questions!==cache.questions){
        const records=new Map(state.questions.map(q=>[S.key(q),q]));
        for(const previous of cache.questions){const next=records.get(S.key(previous));
          if(!next)throw error('state_conflict','question_loss');
          if(previous===next)continue;
          for(const field of ['question_ids','explanations','contexts'])if((previous[field]||[]).some(v=>!(next[field]||[]).some(w=>C.stable(v)===C.stable(w))))throw error('state_conflict','provenance_loss');
          if(['source','analysis'].some(k=>previous[k]&&next[k]!==previous[k]&&!(next.explanations||[]).includes(previous[k])))throw error('state_conflict','provenance_loss');
        }
      }
    }
    async function publish(state,expected,migration=false){
      if(blockedIO)throw error('storage_timeout','write');
      const current=await get(HEAD);if((current?.revision||0)!==expected)throw error('state_conflict','revision');
      guard(state);const head=await encode(state,expected+1);
      if(migration){const restored=await decode(head);if(C.stable(restored)!==C.stable(state))throw error('migration_failed','migration_verify');}
      const latest=await get(HEAD);if((latest?.revision||0)!==expected)throw error('state_conflict','revision');
      await put({[HEAD]:head});
      const confirmed=await get(HEAD);if(confirmed?.commit_id!==head.commit_id)throw error('state_conflict','commit_verify');
      remember(state,head);lastCommit={result:'committed',revision:head.revision,time:now()};return head;
    }
    async function save(state){return lock(async()=>{
      const expected=state[REV]??revisions.get(state)??cacheHead?.revision??0;
      // Derived states retain the caller's base revision through S.merge/runner shallow copies.
      if(expected!==(cacheHead?.revision||0))throw error('state_conflict','revision');
      if(!cacheHead){await publish(cache,0,true);await publish(state,1);}
      else await publish(state,expected);
    }).catch(e=>{lastCommit={result:'failed',code:classify(e).code,time:now()};throw e;});}
    async function fault(e){
      const detail=classify(e);lastFault={...detail,time:now(),blocking:true};
      try{await put({[FAULT]:lastFault});}catch{/* Storage may be unavailable; never invent a successful durable pause. */}
      return detail.code;
    }
    async function acknowledge(){if(lastFault){const next={...lastFault,blocking:false};await put({[FAULT]:next});lastFault=next;}}
    async function receipt(a,request,result){
      if(result===undefined){const entry=await get(RECEIPT);if(!entry||committed(entry,cache)||entry.run_id!==a.run_id||entry.request_id!==request.id)return null;
        const chunks=[];for(let i=0;i<entry.chunks;i++){const piece=await get(RECEIPT+':'+entry.slot+':'+i);if(typeof piece!=='string')throw error('integrity_error','receipt_read');chunks.push(piece);}
        const text=chunks.join('');if(await hash(text)!==entry.digest)throw error('integrity_error','receipt_read');return JSON.parse(text);}
      const text=stringify(result);if(text.length>6*1024*1024)throw error('serialization','receipt_size');
      const prior=await get(RECEIPT),digest=await hash(text);
      if(prior&&!committed(prior,cache)){if(prior.request_id===request.id&&prior.run_id===a.run_id&&prior.digest===digest){await receipt(a,request);return;}throw error('state_conflict','receipt');}
      const slot=prior?.slot===0?1:0,chunks=Math.ceil(text.length/30000);
      for(let i=0;i<chunks;i++){const key=RECEIPT+':'+slot+':'+i,piece=text.slice(i*30000,(i+1)*30000);await put({[key]:piece});if(await get(key)!==piece)throw error('integrity_error','receipt_verify');}
      const entry={version:1,slot,chunks,digest,run_id:a.run_id,request_id:request.id,task_id:request.task_id||null,completed:false};
      await put({[RECEIPT]:entry});if((await get(RECEIPT))?.digest!==digest)throw error('integrity_error','receipt_verify');
    }
    async function diagnostics(){
      let bytes=null;try{if(storage.getBytesInUse)bytes=await call('getBytesInUse',null);}catch{/* Unknown usage is not zero. */}
      let pending=false;try{pending=!committed(await get(RECEIPT),cache||S.empty());}catch{pending=true;}
      return {schema:cacheHead?2:1,revision:cacheHead?.revision||0,usage_bytes:bytes,last_error:lastFault?{code:lastFault.code,stage:lastFault.stage,time:lastFault.time,blocking:lastFault.blocking}:null,
        last_success_at:lastCommit?.result==='committed'?lastCommit.time:cacheHead?.committed_at||cache?.status?.last_saved_at||null,last_commit:lastFault?.blocking&&pending?{result:'failed',code:lastFault.code,time:lastFault.time}:lastCommit|| (cacheHead?{result:'committed',revision:cacheHead.revision,time:cacheHead.committed_at}:null),
        pending_recovery:pending||Boolean(cache?.automation?.inflight),legacy_backup_retained:Boolean(legacyRetained),io_pending:Boolean(blockedIO)};
    }
    return {load,save,fault,acknowledge,receipt,diagnostics,inherit:(from,to)=>{to[REV]=from[REV]??revisions.get(from)??cacheHead?.revision??0;revisions.set(to,to[REV]);return to;}};
  }
  globalThis.DhuPersistence=Object.freeze({HEAD,FAULT,RECEIPT,PREFIX,labels,error,classify,create});
})();
