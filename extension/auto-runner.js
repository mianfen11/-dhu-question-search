/* MV3 coordinator. Each transaction is serialized with passive writes; network waits are not. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore,S=globalThis.DhuBankStore,Q=globalThis.DhuQueue;
  const ERRORS=['http_401','http_403','http_429','network_error','request_aborted','response_shape','response_size','transport_unverified',
    'client_unavailable','page_busy','receipt_missing','page_unavailable','invalid_command','storage_error','rows_rejected'];
  const reason=value=>ERRORS.includes(value)?value:'response_shape';
  function create(io){
    let running=false,volatileError=null,halted=null;
    async function inspect(tab_id){try{return await io.execute({tab_id},{op:'info'});}catch{throw new Error('无法连接原站页面，请检查标签页及扩展网站访问权限');}}
    const save=state=>io.save(state);
    const stats=state=>{
      const next=state.queue?.tasks.find(t=>t.status==='pending'),round=next?.round||state.automation?.rounds;
      return {...S.summary(state),queue:Q.summary(state),automation:state.automation||null,automation_error:volatileError,
        automation_round_added:state.queue?.tasks.filter(t=>t.round===round).reduce((n,t)=>n+t.added,0)||0};
    };
    async function command(state,message){
      const old=state.automation;
      if(message.kind==='auto_start') {
        if(old?.inflight||old&&['running','paused'].includes(old.status))throw new Error('已有自动计划，请继续或先停止');
        const interval=message.interval_seconds??5,rounds=message.rounds??1;
        if(!Number.isInteger(interval)||interval<5||interval>86400||!Number.isInteger(rounds)||rounds<1||rounds>10)throw new Error('间隔须为 5～86400 秒，轮数须为 1～10');
        if(!Number.isInteger(message.tab_id)||message.tab_id<0)throw new Error('请打开并选中已登录的题库页面');
        const info=await inspect(message.tab_id);
        const manual=message.manual_id||info.result?.manual_id;
        if(!info.result?.ok||!info.documentId||typeof manual!=='string'||!/^[1-9]\d{0,15}$/.test(manual))throw new Error('无法使用原站请求客户端，请打开带 manual_id 的题库页面或选择已观察手册');
        const queue=Q.empty();queue.catalogs=Q.read(state).catalogs;
        const now=io.now();
        const automation={version:1,run_id:crypto.randomUUID(),permission:'user_authorized',status:'running',phase:'chapters',
          tab_id:message.tab_id,document_id:info.documentId,manual_id:manual,rounds,interval_ms:interval*1000,
          inflight:null,next_at:Math.max(now,old?.next_at||0),last_request_at:null,last_error:null,round_results:[]};
        halted=null;volatileError=null;return {...state,queue,automation};
      }
      if(!old)throw new Error('没有自动计划');
      const next=structuredClone(state),a=next.automation;
      if(message.action==='pause') {
        if(a.status!=='running')throw new Error('计划未运行');
        halted='paused';a.status='paused';a.last_error='user_pause';
      }else if(message.action==='stop') {
        if(!['running','paused'].includes(a.status))throw new Error('没有可停止的计划');
        halted='stopped';a.status='stopped';a.last_error='user_stop';
      }else if(message.action==='resume') {
        if(a.status!=='paused')throw new Error('仅暂停计划可以继续');
        if(a.inflight)throw new Error('正在结束上一次请求，请稍后继续');
        // Rebind only on explicit resume after reload/restart, never silently to a second tab.
        const info=await inspect(message.tab_id??a.tab_id);
        if(!info.result?.ok||!info.documentId)throw new Error('请保持已登录题库标签页打开');
        a.tab_id=message.tab_id??a.tab_id;a.document_id=info.documentId;
        halted=null;a.status='running';a.last_error=null;a.next_at=Math.max(a.next_at||0,io.now());volatileError=null;
      }else throw new Error('无效的自动计划操作');
      if(a.status!=='running'&&next.queue.status==='tracking')next.queue.status=a.status==='stopped'?'stopped':'paused';
      if(a.status==='running'&&next.queue.status==='paused')next.queue.status='tracking';
      return next;
    }
    async function tick(){
      if(running){io.watchdog?.();return;}running=true;
      let claim=null;
      try {
        claim=await io.serial(async()=>{
          const state=await io.load(),a=state.automation;
          if(!a)return null;
          // Outstanding receipts are recovered even after a pause/stop, without sending new requests.
          if(a.inflight)return {a:structuredClone(a),request:{...a.inflight,op:'probe'}};
          if(a.status!=='running'||halted)return null;
          if(a.next_at>io.now()){io.schedule(a.next_at);return null;}
          const task=a.phase==='questions'?state.queue.tasks.find(t=>t.status==='pending'):null;
          if(a.phase==='questions'&&!task){a.status='completed';state.queue.status='round_finished';await save(state);return null;}
          const request={id:crypto.randomUUID(),kind:task?.question_type||'chapters',manual_id:a.manual_id,
            ...(task?{task_id:task.id,chapter_id:task.chapter_id,question_type:task.question_type}:{})};
          a.inflight=request;a.last_request_at=io.now();
          await save(state);io.schedule(io.now()+30000);
          return {a:structuredClone(a),request:{...request,op:'request'}};
        });
        if(!claim)return;
        let result;
        try {result=(await io.execute(claim.a,claim.request)).result;}
        catch {result={ok:false,reason:'page_unavailable'};}
        await io.serial(async()=>{
          let state=await io.load(),a=state.automation;
          if(!a||a.run_id!==claim.a.run_id||a.inflight?.id!==claim.request.id)return;
          if(halted&&a.status==='running'){a.status=halted;a.last_error=halted==='stopped'?'user_stop':'user_pause';}
          const wasRunning=a.status==='running';
          a.inflight=null;a.next_at=io.now()+a.interval_ms;
          if(result?.ok!==true){a.last_error=reason(result?.reason);if(wasRunning){a.status='paused';if(state.queue.status==='tracking')state.queue.status='paused';}}
          else if(claim.request.kind==='chapters'){
            try {
              if(result.chapters?.manual_id!==a.manual_id)throw new Error('response_shape');
              state.queue=Q.catalog(Q.read(state),result.chapters);
              state.queue.status='idle';state.queue=Q.control(state.queue,'start',{manual_id:a.manual_id,rounds:a.rounds});
              a.phase='questions';
              if(!wasRunning)state.queue.status=a.status==='stopped'?'stopped':'paused';
            }catch{a.last_error='response_shape';if(wasRunning)a.status='paused';}
          }else{
            if(!Array.isArray(result.questions)||result.questions.length>10000||!Number.isInteger(result.rejected)||result.rejected<0||result.rejected>10000){
              a.last_error='response_shape';if(wasRunning)a.status='paused';
            }else{
              const meta=C.endpoint('https://api.aidhu.net/api/protected/app/manual/chapter/questions/'+claim.request.kind+'?manual_id='+a.manual_id+'&chapter_id='+claim.request.chapter_id);
              // Re-project MAIN data; never trust arbitrary fields or context from that world.
              const rows=[];let rejected=result.rejected;
              for(const row of result.questions){try{rows.push(C.filterRow(row,meta));}catch{rejected++;}}
              const merged=await S.merge(state,rows);state=merged.state;a=state.automation;
              const task=state.queue.tasks.find(t=>t.id===claim.request.task_id);
              task.added+=merged.result.added;task.duplicates+=merged.result.duplicates;task.rejected+=merged.result.rejected+rejected;
              if(merged.result.rejected||rejected){a.last_error='rows_rejected';if(wasRunning)a.status='paused';}
              else{
                task.status='observed';task.response_id=claim.request.id;
                if(!state.queue.tasks.some(t=>t.round===task.round&&t.status!=='observed')){
                  a.round_results= a.round_results.filter(r=>r.round!==task.round);
                  a.round_results.push({round:task.round,added:state.queue.tasks.filter(t=>t.round===task.round).reduce((n,t)=>n+t.added,0)});
                }
                if(state.queue.tasks.every(t=>t.status==='observed')){state.queue.status='round_finished';if(wasRunning)a.status='completed';}
              }
            }
          }
          if(['paused','stopped'].includes(a.status)&&state.queue.status==='tracking')state.queue.status=a.status;
          await save(state);volatileError=null;
          if(a.status==='running')io.schedule(a.next_at);
        });
      }catch{volatileError='storage_error';if(claim)io.schedule(io.now()+30000);}
      finally{running=false;}
    }
    async function cancel(a){if(a?.inflight)try{await io.execute(a,{op:'cancel',id:a.inflight.id});}catch{/* Only status, never raw exception. */}}
    return {command,tick,cancel,stats};
  }
  globalThis.DhuAutoRunner=Object.freeze({create});
})();
