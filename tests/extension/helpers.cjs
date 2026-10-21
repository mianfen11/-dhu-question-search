const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../../extension');
function run(context,file) { vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file}); }
function context(extra={}) {
  const c=vm.createContext({console,URL,URLSearchParams,TextEncoder,TextDecoder,crypto:globalThis.crypto,
    Request,Response,Uint8Array,setTimeout,clearTimeout,structuredClone,...extra});
  run(c,'entities.js'); run(c,'core.js'); run(c,'handshake.js');
  return c;
}
const plain=value => JSON.parse(JSON.stringify(value));
const row=(updates={}) => ({question_id:1,question_type:'one_choice',question:'模拟题',A:'甲',B:'乙',answer:'A',source:'解析',...updates});
const page='https://aidhu.net/web/#/main/handbookAnswer?manual_id=1&chapter_id=1&mode=practice';
const url='https://api.aidhu.net/api/protected/app/manual/chapter/questions/one_choice?manual_id=1&chapter_id=1';
module.exports={run,context,plain,row,page,url,root};

// Decode committed storage, not a worker cache, to assert durability in tests.
function persisted(data){
  const h=data.dhuBankHeadV2;if(!h)return data.questionBankV1;
  const blob=id=>{const v=data['dhuBlobV2:'+id];return JSON.parse(typeof v==='string'?v:v.parts.map(p=>data['dhuBlobV2:part:'+p]).join(''));};
  const list=pages=>pages.flatMap(p=>blob(p).map(blob));
  const result={};for(const [k,v]of Object.entries(h.parts))if(!['queue','catalogs'].includes(k))result[k]=blob(v);
  result.questions=list(h.questions);if(h.parts.queue)result.queue={...blob(h.parts.queue),catalogs:blob(h.parts.catalogs),tasks:list(h.tasks)};
  return result;
}
module.exports.persisted=persisted;
