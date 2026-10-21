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
  async function merge(state, rows) {
    if (!Array.isArray(rows) || rows.length > 50000) throw new Error('单次最多导入 50000 条题目');
    const questions=state.questions.map(q => ({...q,question_ids:[...(q.question_ids||[])],explanations:[...(q.explanations||[])]}));
    const byKey=new Map(questions.map(q => [C.stable(C.content(q)),q]));
    let added=0, duplicates=0, rejected=0;
    const errors=[];
    for (let index=0; index<rows.length; index++) {
      try {
        const row=rows[index], q=C.normalize(row), key=C.stable(C.content(q));
        // Never retain arbitrary imported/raw properties, tokens, headers or cookies.
        const explanations=[q.explanation];
        for (const field of ['explanation','analysis','source']) if (row[field] != null) explanations.push(C.text(row[field]));
        if (Array.isArray(row.explanations)) for (const s of row.explanations.slice(0,100)) explanations.push(C.text(s));
        const ids = new Set(q.question_id ? [q.question_id] : []);
        if (Array.isArray(row.question_ids)) for (const value of row.question_ids.slice(0,100)) if (value != null && C.text(value)) ids.add(C.text(value));
        const existing=byKey.get(key);
        if (existing) {
          existing.question_ids=[...new Set([...existing.question_ids,...ids])];
          existing.explanations=[...new Set([...existing.explanations,...explanations.filter(Boolean)])];
          duplicates++;
        } else {
          q.record_id=await C.fingerprint(q);
          q.question_ids=[...ids]; q.explanations=[...new Set(explanations.filter(Boolean))];
          questions.push(q); byKey.set(key,q); added++;
        }
      } catch (error) {
        rejected++;
        // Report location/reason, never arbitrary raw input.
        if (errors.length < 30) errors.push({index,error:error.message});
      }
    }
    return {state:{...state,schema_version:1,questions,status:{...state.status,last_saved_at:new Date().toISOString(),last_error:rejected?`${rejected} 条记录无效，未保存`:null}},
      result:{added,duplicates,rejected,errors,total:questions.length}};
  }
  function summary(state) {
    const counts=Object.fromEntries(C.TYPES.map(t => [t,0]));
    const stems=new Map(), ids=new Map(); let conflicts=0;
    for (const q of state.questions) {
      counts[q.question_type]++;
      const key=C.stable(C.content(q,false)), answer=JSON.stringify(q.answer);
      if (stems.has(key) && stems.get(key) !== answer) conflicts++;
      stems.set(key,answer);
      for (const id of q.question_ids || []) {
        const identity=JSON.stringify([q.manual_id,id]), content=C.stable(C.content(q));
        if (ids.has(identity) && ids.get(identity) !== content) conflicts++;
        ids.set(identity,content);
      }
    }
    return {total:state.questions.length,counts,conflicts,...state.status};
  }
  function exportBank(state) {
    const stats=summary(state);
    return {schema_version:1,questions:state.questions,report:{unique_records:stats.total,counts_by_type:stats.counts,
      conflict_count:stats.conflicts,completeness:'unverified',public_reuse_permission:'unverified',
      collection_method:'user_loaded_practice_responses',exported_at:new Date().toISOString()}};
  }
  globalThis.DhuBankStore=Object.freeze({KEY,empty,load,merge,summary,exportBank});
})();
