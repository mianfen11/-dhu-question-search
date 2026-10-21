'use strict';
const $=id => document.getElementById(id);
let busy=false;
function showStats(stats) {
  $('total').textContent=String(stats.total);
  for (const kind of ['one_choice','multi_choice','judge']) $(kind).textContent=String(stats.counts[kind]);
  $('conflicts').textContent=String(stats.conflicts);
  $('saved').textContent=stats.last_saved_at ? '最近保存：'+new Date(stats.last_saved_at).toLocaleString() : '尚未保存题目';
  $('storage-error').textContent=stats.last_error || '';
}
async function send(message) {
  const response=await chrome.runtime.sendMessage(message);
  if (!response?.ok) throw new Error(response?.error || '扩展后台无响应，请重新打开弹窗');
  return response;
}
async function action(fn) {
  if (busy) return;
  busy=true;
  for (const id of ['export','import','refresh']) $(id).disabled=true;
  try { await fn(); }
  catch (error) { $('message').textContent='操作失败：'+error.message; }
  finally {
    busy=false;
    for (const id of ['export','import','refresh']) $(id).disabled=false;
  }
}
async function refresh() { showStats((await send({kind:'stats'})).stats); }
$('refresh').addEventListener('click',() => action(refresh));
$('export').addEventListener('click',() => action(async () => {
  const {bank}=await send({kind:'export'});
  const blob=new Blob([JSON.stringify(bank,null,2)+'\n'],{type:'application/json;charset=utf-8'});
  const url=URL.createObjectURL(blob), anchor=document.createElement('a');
  anchor.href=url; anchor.download='dhu-question-bank-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json';
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url),60000);
  $('message').textContent=`已发起导出 ${bank.questions.length} 道题目的下载。`;
}));
$('import').addEventListener('click',() => $('file').click());
$('file').addEventListener('change',() => action(async () => {
  const file=$('file').files[0]; $('file').value='';
  if (!file) return;
  if (file.size > 20*1024*1024) throw new Error('文件不能超过 20 MB');
  const response=await send({kind:'import',json:await file.text()});
  showStats(response.stats);
  const r=response.result;
  $('message').textContent=`新增 ${r.added}；合并 ${r.duplicates}；拒绝 ${r.rejected}。`+
    (r.errors.length ? '\n'+r.errors.map(e => `第 ${e.index+1} 条：${e.error}`).join('\n') : '');
}));
chrome.storage.onChanged.addListener((changes,area) => {
  if (area==='local' && changes.questionBankV1 && !busy) void action(refresh);
});
void action(refresh);
