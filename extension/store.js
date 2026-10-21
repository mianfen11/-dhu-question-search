/* Shared storage/export engine. All writes are serialized by the worker. */
(() => {
  'use strict';
  const C=globalThis.DhuBankCore, KEY='questionBankV1';
  function empty() { return {schema_version:1,questions:[],status:{last_saved_at:null,last_error:null}}; }
  async function load(storage) {
    const result=await storage.get(KEY), state=result[KEY];
    if (state == null) return empty();
    if (!C.object(state) || state.schema_version !== 1 || !Array.isArray(state.questions) || !C.object(state.status)) throw new Error('本地题库格式异常，已停止写入以保护数据');
    return state;
  }
  function key(q){return C.stable({question_type:q.question_type,question:q.question,options:q.options,answer:q.answer});}
  function contexts(q){
    const values=[{manual_id:q.manual_id,chapter_id:q.chapter_id},...(Array.isArray(q.contexts)?q.contexts:[])];
    const result=[];
    for(const v of values){if(!C.object(v))continue;
      const valid=x=>x===null||typeof x==='string'&&/^[1-9]\d{0,15}$/.test(x);
      if(!valid(v.manual_id)||!valid(v.chapter_id))continue;
      if(!result.some(c=>c.manual_id===v.manual_id&&c.chapter_id===v.chapter_id))result.push({manual_id:v.manual_id,chapter_id:v.chapter_id});
    }return result;
  }
  const indices=new WeakMap(),summaries=new WeakMap();
  async function merge(state, rows) {
    if (!Array.isArray(rows) || rows.length > 50000) throw new Error('单次最多导入 50000 条题目');
    // Immutable/copy-on-write records let persistence reuse unchanged blobs.
    let indexed=indices.get(state.questions);
    if(!indexed){
      const base=[],positions=new Map();
      for(const original of state.questions){
        const identity=key(original),at=positions.get(identity);
        if(at!==undefined){
          const prior=base[at];base[at]={...prior,
            question_ids:[...new Set([...(prior.question_ids||[]),...(original.question_ids||[])])],
            explanations:[...new Set([...(prior.explanations||[]),...(original.explanations||[]),...[prior.source,prior.analysis,original.source,original.analysis].filter(Boolean)])],
            contexts:contexts({...prior,contexts:[...contexts(prior),...contexts(original)]}),
            source:prior.source||original.source||'',analysis:prior.analysis||original.analysis||''};
        }else{positions.set(identity,base.length);base.push(original);}
      }
      indexed={base,positions};indices.set(state.questions,indexed);
    }
    const questions=indexed.base.slice(),byKey=new Map(indexed.positions);
    let added=0, duplicates=0, rejected=0;
    const errors=[];
    for (let index=0; index<rows.length; index++) {
      try {
        const row=rows[index], q=C.normalize(row), identity=key(q);
        q.source=C.text(row.source);q.analysis=C.text(row.analysis);q.contexts=contexts({...q,contexts:row.contexts});
        // Never retain arbitrary imported/raw properties, tokens, headers or cookies.
        const explanations=[q.explanation];
        for (const field of ['explanation','analysis','source']) if (row[field] != null) explanations.push(C.text(row[field]));
        if (Array.isArray(row.explanations)) for (const s of row.explanations.slice(0,100)) explanations.push(C.text(s));
        const ids = new Set(q.question_id ? [q.question_id] : []);
        if (Array.isArray(row.question_ids)) for (const value of row.question_ids.slice(0,100)) if (value != null && C.text(value)) ids.add(C.text(value));
        const position=byKey.get(identity),existing=position===undefined?null:questions[position];
        if (existing) {
          const next={...existing,question_ids:[...(existing.question_ids||[])],explanations:[...(existing.explanations||[])]};
          next.question_ids=[...new Set([...(existing.question_ids||[]),...ids])];
          next.explanations=[...new Set([...(existing.explanations||[]),...explanations.filter(Boolean)])];
          next.contexts=contexts({...existing,contexts:[...contexts(existing),...q.contexts]});
          for(const field of ['source','analysis'])if(!next[field]&&q[field])next[field]=q[field];
          if(C.stable(next)!==C.stable(existing))questions[position]=next;
          duplicates++;
        } else {
          q.record_id=await C.fingerprint(q);
          q.question_ids=[...ids]; q.explanations=[...new Set(explanations.filter(Boolean))];
          byKey.set(identity,questions.length);questions.push(q);added++;
        }
      } catch (error) {
        rejected++;
        // Report location/reason, never arbitrary raw input.
        if (errors.length < 30) errors.push({index,error:error.message});
      }
    }
    const unchanged=questions.length===state.questions.length&&questions.every((q,i)=>q===state.questions[i]);
    const saved=unchanged?state.questions:questions;indices.set(saved,{base:saved,positions:byKey});
    return {state:{...state,schema_version:1,questions:saved,status:{...state.status,last_saved_at:new Date().toISOString(),last_error:rejected?`${rejected} 条记录无效，未保存`:null}},
      result:{added,duplicates,rejected,errors,total:questions.length}};
  }
  function summary(state) {
    if(summaries.has(state.questions))return {...summaries.get(state.questions),...state.status};
    const counts=Object.fromEntries(C.TYPES.map(t => [t,0]));
    const stems=new Map(), ids=new Map(); let conflicts=0;
    for (const q of state.questions) {
      counts[q.question_type]++;
      const key=C.stable({question_type:q.question_type,question:q.question}), answer=C.stable({answer:q.answer,options:q.options});
      if (stems.has(key) && stems.get(key) !== answer) conflicts++;
      stems.set(key,answer);
      for (const id of q.question_ids || []) {
        const identity=JSON.stringify([q.manual_id,id]), content=C.stable(C.content(q));
        if (ids.has(identity) && ids.get(identity) !== content) conflicts++;
        ids.set(identity,content);
      }
    }
    const result={total:state.questions.length,counts,conflicts};summaries.set(state.questions,result);return {...result,...state.status};
  }
  function exportBank(state) {
    const stats=summary(state);
    return {schema_version:1,questions:state.questions,report:{unique_records:stats.total,counts_by_type:stats.counts,
      conflict_count:stats.conflicts,completeness:'unverified',public_reuse_permission:'unverified',
      collection_method:state.automation?'user_authorized_serial_collection':'user_loaded_practice_responses',exported_at:new Date().toISOString()}};
  }
  globalThis.DhuBankStore=Object.freeze({KEY,empty,load,key,merge,summary,exportBank});
})();
