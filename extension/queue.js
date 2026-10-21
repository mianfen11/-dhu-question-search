/* Offline plan bookkeeping only. No fetch, navigation, clicks, alarms or executor. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore;
  const id=v=>typeof v==='string' && /^[1-9]\d{0,15}$/.test(v);
  function empty() {return {version:1,permission:'unverified',status:'idle',catalogs:[],manual_id:null,rounds:0,tasks:[],receipts:[],processed:[],pause_reason:null,created_at:null};}
  function read(bank) {
    const q=bank.queue;
    if(q==null)return empty();
    if(!C.object(q)||q.version!==1||q.permission!=='unverified'||!['idle','tracking','paused','stopped','round_finished'].includes(q.status)||
      !Array.isArray(q.catalogs)||!Array.isArray(q.tasks)||!Array.isArray(q.receipts)||!Array.isArray(q.processed))throw new Error('离线队列格式异常，停止改写');
    return structuredClone(q);
  }
  function catalog(queue,message) {
    const safe=C.queueMessage(message);
    if(safe.event!=='chapters')throw new Error('不是章节清单');
    const q=structuredClone(queue),entry={manual_id:safe.manual_id,chapters:safe.chapters};
    const i=q.catalogs.findIndex(c=>c.manual_id===entry.manual_id);
    if(i<0){if(q.catalogs.length>=20)throw new Error('最多保存 20 份手册章节清单');q.catalogs.push(entry);}else q.catalogs[i]=entry;
    return q;
  }
  function control(queue,action,options={}) {
    const q=structuredClone(queue);
    if(action==='start') {
      if(!['idle','stopped','round_finished'].includes(q.status))throw new Error('已有计划，请暂停/继续或先停止，不会重建进度');
      if(!id(options.manual_id)||!Number.isInteger(options.rounds)||options.rounds<1||options.rounds>10)throw new Error('选择手册及 1～10 个有限观察轮次');
      const c=q.catalogs.find(c=>c.manual_id===options.manual_id);
      if(!c?.chapters.length)throw new Error('请先在平台正常打开章节列表，以观察到的清单建立计划');
      q.manual_id=c.manual_id;q.rounds=options.rounds;q.tasks=[];q.receipts=[];q.processed=[];
      for(let round=1;round<=q.rounds;round++)for(const chapter of c.chapters)for(const type of C.TYPES)
        q.tasks.push({id:[c.manual_id,chapter.chapter_id,type,round].join(':'),manual_id:c.manual_id,chapter_id:chapter.chapter_id,
          name:chapter.name,question_type:type,round,status:'pending',response_id:null,added:0,duplicates:0,rejected:0});
      q.status='tracking';q.created_at=new Date().toISOString();q.pause_reason=null;
    } else if(action==='pause') {
      if(q.status!=='tracking')throw new Error('仅记录中的计划可以暂停');
      q.status='paused';q.pause_reason='user';q.processed.push(...q.receipts.map(r=>r.id));q.receipts=[];
    } else if(action==='resume') {
      if(q.status!=='paused')throw new Error('仅暂停中的计划可以继续');
      if(q.processed.length>=30000)throw new Error('本计划已达到有限观察上限，请停止后建立新计划');
      q.status='tracking';q.pause_reason=null;
    } else if(action==='stop') {
      if(!['tracking','paused'].includes(q.status))throw new Error('没有可停止的计划');
      q.status='stopped';q.pause_reason='user';q.processed.push(...q.receipts.map(r=>r.id));q.receipts=[];
    } else throw new Error('不支持的离线队列操作');
    return q;
  }
  function blocked(queue,status) {
    if(![401,403,429].includes(status))throw new Error('不支持的暂停状态');
    const q=structuredClone(queue);
    if(['tracking','paused'].includes(q.status)){q.status='paused';q.pause_reason='http_'+status;q.processed.push(...q.receipts.map(r=>r.id));q.receipts=[];}
    return q;
  }
  function alreadyProcessed(queue,capture) {
    if(!capture)return false;
    return queue.processed.includes(capture.response_id) || queue.tasks.some(t=>t.response_id===capture.response_id) ||
      queue.receipts.some(r=>r.id===capture.response_id && r.batches.includes(capture.batch_index));
  }
  function observe(queue,meta,capture,result) {
    const q=structuredClone(queue);
    if(q.status!=='tracking'||!capture||alreadyProcessed(q,capture))return q;
    if(q.processed.length>=30000){q.status='paused';q.pause_reason='observation_limit';return q;}
    let r=q.receipts.find(r=>r.id===capture.response_id);
    if(!r) {
      // A later batch alone cannot prove the whole HTTP response was observed.
      if(capture.batch_index!==0)return q;
      // A new complete attempt may replace an interrupted response, including after browser restart.
      const abandoned=q.receipts.filter(x=>['manual_id','chapter_id','question_type'].every(k=>x[k]===meta[k]));
      q.processed.push(...abandoned.map(x=>x.id));
      q.receipts=q.receipts.filter(x=>!abandoned.includes(x));
      const task=q.tasks.find(t=>t.status==='pending' && t.manual_id===meta.manual_id && t.chapter_id===meta.chapter_id &&
        t.question_type===meta.question_type && !q.receipts.some(r=>r.task_id===t.id));
      if(!task)return q;
      r={id:capture.response_id,task_id:task.id,manual_id:meta.manual_id,chapter_id:meta.chapter_id,question_type:meta.question_type,
        batch_count:capture.batch_count,batches:[],rejected:capture.rejected_rows||0};q.receipts.push(r);
    }
    if(r.batch_count!==capture.batch_count||['manual_id','chapter_id','question_type'].some(k=>r[k]!==meta[k]))return q;
    const task=q.tasks.find(t=>t.id===r.task_id);
    if(!r.batches.length)task.rejected+=capture.rejected_rows||0;
    r.batches.push(capture.batch_index);r.rejected+=result.rejected;
    task.added+=result.added;task.duplicates+=result.duplicates;task.rejected+=result.rejected;
    if(r.batches.length===r.batch_count) {
      if(r.rejected===0){task.status='observed';task.response_id=r.id;}
      q.processed.push(r.id);
      q.receipts=q.receipts.filter(x=>x!==r);
    }
    if(q.tasks.length && q.tasks.every(t=>t.status==='observed'))q.status='round_finished';
    return q;
  }
  function summary(bank) {
    const q=read(bank),chapters=[];
    for(const catalog of q.catalogs)for(const c of catalog.chapters)chapters.push({manual_id:catalog.manual_id,chapter_id:c.chapter_id,name:c.name,total:0,counts:Object.fromEntries(C.TYPES.map(t=>[t,0]))});
    for(const question of bank.questions) {
      const contexts=Array.isArray(question.contexts)&&question.contexts.length?question.contexts:[question];
      const seen=new Set();
      for(const context of contexts){
        const key=JSON.stringify([context.manual_id,context.chapter_id]);if(seen.has(key))continue;seen.add(key);
        let chapter=chapters.find(c=>c.manual_id===context.manual_id && c.chapter_id===context.chapter_id);
        if(!chapter){chapter={manual_id:context.manual_id,chapter_id:context.chapter_id,total:0,counts:Object.fromEntries(C.TYPES.map(t=>[t,0]))};chapters.push(chapter);}
        chapter.total++;chapter.counts[question.question_type]++;
      }
    }
    const progress=q.tasks.reduce((r,t)=>{r[t.status==='observed'?'observed':'pending']++;r.added+=t.added;r.duplicates+=t.duplicates;r.rejected+=t.rejected;return r;},
      {total:q.tasks.length,observed:0,pending:0,added:0,duplicates:0,rejected:0});
    return {status:q.status,permission:bank.automation?'user_authorized':'unverified',automation_enabled:Boolean(bank.automation),completeness:'unverified',pause_reason:q.pause_reason,
      manual_id:q.manual_id,rounds:q.rounds,catalogs:q.catalogs,progress,chapters,next:q.tasks.find(t=>t.status==='pending')||null};
  }
  globalThis.DhuQueue=Object.freeze({empty,read,catalog,control,blocked,alreadyProcessed,observe,summary});
})();
