const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.resolve(__dirname,'../../extension');
function run(context,file) { vm.runInContext(fs.readFileSync(path.join(root,file),'utf8'),context,{filename:file}); }
function context(extra={}) {
  const c=vm.createContext({console,URL,URLSearchParams,TextEncoder,TextDecoder,crypto:globalThis.crypto,
    Request,Response,Uint8Array,setTimeout,clearTimeout,structuredClone,...extra});
  run(c,'entities.js'); run(c,'core.js');
  return c;
}
const plain=value => JSON.parse(JSON.stringify(value));
const row=(updates={}) => ({question_id:1,question_type:'one_choice',question:'模拟题',A:'甲',B:'乙',answer:'A',source:'解析',...updates});
const page='https://aidhu.net/web/#/main/handbookAnswer?manual_id=1&chapter_id=1&mode=practice';
const url='https://api.aidhu.net/api/protected/app/manual/chapter/questions/one_choice?manual_id=1&chapter_id=1';
module.exports={run,context,plain,row,page,url,root};
