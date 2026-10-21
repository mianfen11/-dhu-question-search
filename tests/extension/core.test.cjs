const {test}=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {context,plain,row,page,url}=require('./helpers.cjs');
const C=context().DhuBankCore;

test('only exact domain, HTTPS, practice SPA route and allowed endpoints',() => {
  assert.equal(C.isPracticePage(page),true);
  for (const href of [page.replace('aidhu.net','evil.test'),page.replace('https:','http:'),page.replace('mode=practice','mode=exam'),page.replace('handbookAnswer?','handbookAnswerResult?')]) assert.equal(C.isPracticePage(href),false);
  assert.ok(C.endpoint(url));
  for (const candidate of [url.replace('api.aidhu.net','api.aidhu.net.evil.test'),url.replace('https:','http:'),url.replace('one_choice?','one_choice/?'),url+'&chapter_id=2',url.replace('chapter_id=1','chapter_id=0'),url.replace('api.aidhu.net','x:y@api.aidhu.net'),url.replace('one_choice','exam_question')]) assert.equal(C.endpoint(candidate),null);
});
test('bridge strips unknown auth properties and rejects mismatched contexts',() => {
  const meta=C.endpoint(url), dirty=row({Authorization:'secret',Cookie:'secret',password:'secret'});
  const msg=C.bridgeMessage({marker:C.MARKER,version:1,meta,questions:[dirty]},page);
  assert.equal(JSON.stringify(msg).includes('secret'),false);
  assert.throws(() => C.bridgeMessage({...msg,meta:{...meta,path:'/wrong'}},page));
  assert.throws(() => C.bridgeMessage({...msg,Authorization:'must-not-read'},page));
  assert.throws(() => C.bridgeMessage({...msg,questions:[row({chapter_id:2})]},page));
  assert.throws(() => C.bridgeMessage({...msg,questions:[row({answer:{token:'x'}})]},page));
  assert.throws(() => C.bridgeMessage({...msg,questions:Array(101).fill(dirty)},page));
});
test('three question types and all common answer representations',() => {
  for (const answer of ['A,E','ae','Ａ、Ｅ',['E','A','A'],'["A","E"]']) assert.deepEqual(plain(C.normalize(row({question_type:'multi_choice',E:'戊',answer})).answer),['A','E']);
  for (const answer of [true,1,'正确','✓','true']) assert.deepEqual(plain(C.normalize({question_type:'judge',question:'判断',answer}).answer),['1']);
  for (const answer of [false,0,'错误','×','false']) assert.deepEqual(plain(C.normalize({question_type:'judge',question:'判断',answer}).answer),['0']);
  assert.throws(() => C.normalize(row({question:'\ud800'})));
  for (const answer of ['Z','AB',0,null]) assert.throws(() => C.normalize(row({answer})));
  assert.throws(() => C.normalize({question_type:'judge',question:'判断',answer:'A'}));
});
test('Python normalization and fingerprints match JavaScript for fixture matrix',async () => {
  const fixtures=[row(),row({question_type:'multi_choice',E:'戊',answer:'A E',manual_id:1,chapter_id:2}),
    {question_type:'judge',question:'判断',answer:false},
    {type:'单选题',stem:'  &lt;b&gt;题目&lt;/b&gt;\r\n&copy; &#128; &#x1F600;',options:[{key:'Ａ',value:'甲'},{key:'B',value:'乙'}],correct_answer:'a'},
    {question_type:'judge',question:'判断',options:{'1':'正确','0':'错误'},answer:['1']}];
  const py=spawnSync('python3',['-c','import sys,json; from tools.question_bank import normalize,digest; print(json.dumps([dict(q=normalize(r),key=digest({k:normalize(r)[k] for k in ("manual_id","chapter_id","question_type","question","options","answer")})) for r in json.load(sys.stdin)],ensure_ascii=False))'],
    {cwd:path.resolve(__dirname,'../..'),input:JSON.stringify(fixtures),encoding:'utf8'});
  assert.equal(py.status,0,py.stderr);
  const expected=JSON.parse(py.stdout);
  for (let i=0;i<fixtures.length;i++) {
    const q=C.normalize(fixtures[i]);
    assert.deepEqual(plain(q),expected[i].q);
    assert.equal(await C.fingerprint(q),expected[i].key);
  }
});
test('supported envelopes and failed envelopes',() => {
  const data={manual_id:1,chapters:[{chapter_id:2,one_choice:[row()]}]};
  assert.equal(C.unpack(data)[0].chapter_id,2);
  assert.equal(C.unpack({questions:[row()]}).length,1);
  assert.throws(() => C.unpack({code:401,data:[row()]}));
  assert.throws(() => C.unpack({unknown:[]}));
});
