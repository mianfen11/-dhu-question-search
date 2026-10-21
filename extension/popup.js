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
const diagnosticLabels={not_injected:'监听脚本未注入或未完成握手',waiting:'监听已启动，尚未捕获题目响应',captured:'已捕获响应，正在解析',saving:'解析成功，正在保存',parse_error:'捕获响应或消息，但解析失败',storage_error:'解析成功，但后台通信或存储失败',saved:'成功保存题目'};
const diagnosticReasons={observer_missing:'隔离接收器存在，但 MAIN 监听器未应答',bridge_missing:'当前标签页未找到扩展接收器，请检查页面地址、网站访问权限并刷新网页',ready:'MAIN 监听器与隔离接收器握手成功',response_pending:'已收到指定接口响应',json:'响应不是可读取的 JSON',shape:'响应不符合 code:200 与 data 数组结构',size:'响应或题目超过安全大小限制',row_schema:'题目字段或接口上下文不符合白名单',endpoint_context:'接口路径正确，但手册/章节参数无效',http_status:'目标接口返回非成功 HTTP 状态',redirect:'响应最终地址与指定接口不一致',network:'页面原请求失败',unsupported_xhr:'XHR 使用了不支持的响应类型',bridge_rejected:'题目消息未通过扩展校验',queue_full:'待处理消息超过安全限制',saving:'等待后台确认写入',normalization:'题型、选项或答案规范化失败',storage_access:'扩展存储权限初始化失败',storage_read:'读取本地题库失败',storage_write:'本地写入失败，可能达到存储配额',background_unreachable:'后台未确认保存，可能需要重新加载扩展并刷新网页',saved:'后台已确认写入或重复题目合并',empty:'接口返回空题目数组',diagnostic_invalid:'未收到有效的诊断状态',hook_replaced:'页面后来替换了 fetch 或 XHR 监听函数，当前监听可能失效',none:''};
function showDiagnostic(d) {
  const valid=d && Object.hasOwn(diagnosticLabels,d.status) && Object.hasOwn(diagnosticReasons,d.reason);
  const safe=valid?d:{status:'not_injected',reason:'diagnostic_invalid'};
  $('diagnostic-status').textContent=safe.reason==='empty'?'已捕获响应，返回空题目数组':safe.reason==='network'?'监听已启动，但页面本次请求失败':diagnosticLabels[safe.status];
  const count=k=>Number.isSafeInteger(safe[k]) && safe[k]>=0?safe[k]:0;
  $('diagnostic-detail').textContent=diagnosticReasons[safe.reason]+`。本标签页：捕获 ${count('captured')} 次响应，解析 ${count('parsed')} 条，保存/合并 ${count('saved')} 条，拒绝 ${count('rejected')} 条。`;
}
async function diagnoseActiveTab() {
  try {
    // Reading tab IDs and messaging installed content scripts needs no tabs permission.
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    if(!tab || !Number.isInteger(tab.id))throw new Error('no tab');
    const response=await chrome.tabs.sendMessage(tab.id,{kind:'diagnose'},{frameId:0});
    showDiagnostic(response?.ok?response.diagnostic:null);
  } catch {showDiagnostic({status:'not_injected',reason:'bridge_missing'});}
}
async function refresh() {
  await diagnoseActiveTab();
  showStats((await send({kind:'stats'})).stats);
}
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

// Local status polling only; never fetches or replays a question request.
setInterval(()=>{if(!busy)void diagnoseActiveTab();},1000);
