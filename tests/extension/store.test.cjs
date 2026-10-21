const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const {context,run,plain,row}=require('./helpers.cjs');
const c=context(); run(c,'store.js'); const S=c.DhuBankStore;
test('repeated loads deduplicate, different batches and chapters merge',async () => {
  let r=await S.merge(S.empty(),[row(),row()]);
  assert.equal(r.result.added,1); assert.equal(r.result.duplicates,1);
  r=await S.merge(r.state,[row({question_id:2,question:'另一题'}),row(),row({chapter_id:2})]);
  assert.equal(r.state.questions.length,3); assert.equal(r.result.duplicates,1);
});
test('duplicate IDs and explanation variants preserved, credentials discarded',async () => {
  const r=await S.merge(S.empty(),[row({password:'credential-marker',headers:{Authorization:'credential-marker'}}),row({question_id:99,source:'另解'})]);
  assert.deepEqual(plain(r.state.questions[0].question_ids),['1','99']);
  assert.deepEqual(plain(r.state.questions[0].explanations),['解析','另解']);
  assert.equal(JSON.stringify(r.state).includes('credential-marker'),false);
});
test('invalid row does not discard good rows and conflicting answers remain',async () => {
  const r=await S.merge(S.empty(),[row(),row({answer:'Z'}),row({answer:'B'})]);
  assert.equal(r.result.rejected,1); assert.equal(r.state.questions.length,2);
  assert.ok(S.summary(r.state).conflicts>0);
});
test('all types export and import back without duplicates, Python importer accepts export',async () => {
  const r=await S.merge(S.empty(),[row(),row({question_type:'multi_choice',answer:'AB'}),{question_type:'judge',question:'判断',answer:0}]);
  const bank=S.exportBank(r.state);
  const again=await S.merge(r.state,c.DhuBankCore.unpack(bank));
  assert.equal(again.result.added,0); assert.equal(again.result.duplicates,3);
  const py=spawnSync('python3',['-c','import json,sys; from tools.question_bank import import_documents; r=import_documents([("extension",json.load(sys.stdin))]); print(json.dumps(r["report"]))'],{input:JSON.stringify(bank),encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);
  const report=JSON.parse(py.stdout);
  assert.equal(report.unique_records,3); assert.deepEqual(report.rejected,[]);
  assert.deepEqual(report.counts_by_type,{judge:1,multi_choice:1,one_choice:1});
});
test('storage persists across new engine loads; corrupt state never silently overwritten',async () => {
  const r=await S.merge(S.empty(),[row()]);
  const storage={get:async()=>({[S.KEY]:structuredClone(plain(r.state))})};
  const newContext=context();run(newContext,'store.js');
  assert.equal((await newContext.DhuBankStore.load(storage)).questions.length,1);
  await assert.rejects(S.load({get:async()=>({[S.KEY]:{schema_version:9}})}));
});
