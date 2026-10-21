'use strict';
const $=id => document.getElementById(id);
let busy=false,automation=null;
function showStats(stats) {
  $('total').textContent=String(stats.total);
  for (const kind of ['one_choice','multi_choice','judge']) $(kind).textContent=String(stats.counts[kind]);
  $('conflicts').textContent=String(stats.conflicts);
  $('saved').textContent=stats.last_saved_at ? '最近保存：'+new Date(stats.last_saved_at).toLocaleString() : '尚未保存题目';
  $('storage-error').textContent=stats.last_error || '';
  if(stats.queue)showQueue(stats.queue);
  automation=stats.automation||null;
  showAutomatic(stats);
  showStorage(stats);
}
function showQueue(q) {
  const labels={idle:'未建立计划',tracking:'离线记录中（不自动访问）',paused:'已暂停离线记录',stopped:'已停止，历史任务进度保留',round_finished:'计划轮次已观察完，题库完整性未验证'};
  const manual=$('queue-manual'),selected=manual.value;
  manual.replaceChildren();
  const current=document.createElement('option');current.value='';current.textContent='使用当前页面手册';manual.append(current);
  for(const c of q.catalogs){const o=document.createElement('option');o.value=c.manual_id;o.textContent='手册 '+c.manual_id+'（'+c.chapters.length+' 章）';manual.append(o);}
  manual.value=q.catalogs.some(c=>c.manual_id===selected)?selected:['tracking','paused'].includes(q.status)?q.manual_id||'':'';
  const active=['tracking','paused'].includes(q.status);
  manual.disabled=active;$('queue-rounds').disabled=active;
  $('queue-start').disabled=active||!q.catalogs.length;
  $('queue-pause').disabled=q.status!=='tracking';$('queue-resume').disabled=q.status!=='paused';$('queue-stop').disabled=!active;
  const p=q.progress;
  const reason={user:'用户暂停/停止',http_401:'401，需用户检查正常登录',http_403:'403，需确认访问许可',http_429:'429，需确认平台频率限制',observation_limit:'已达到本计划有限观察上限'}[q.pause_reason]||'';
  const type={one_choice:'单选',multi_choice:'多选',judge:'判断'};
  $('queue-status').textContent=(labels[q.status]||'未知状态')+`。任务 ${p.observed}/${p.total}；新增 ${p.added}，重复 ${p.duplicates}，拒绝 ${p.rejected}。`+
    (reason?reason+'。':'')+(q.next?`下一待观察：章节 ${q.next.chapter_id} ${type[q.next.question_type]}，第 ${q.next.round} 轮。`:'')+
    (!q.catalogs.length?'请先在原站正常打开章节列表。':'');
  const tbody=$('chapter-progress');tbody.replaceChildren();
  for(const c of q.chapters){const tr=document.createElement('tr'),name=document.createElement('td'),counts=document.createElement('td');
    name.textContent=`${c.manual_id||'?'} / ${c.chapter_id||'?'} ${c.name||''}`;counts.textContent=`${c.total} / ${c.counts.one_choice} / ${c.counts.multi_choice} / ${c.counts.judge}`;tr.append(name,counts);tbody.append(tr);}
}
function showAutomatic(stats){
  const a=stats.automation,active=a&&['running','paused'].includes(a.status);
  $('auto-start').disabled=Boolean(active||a?.inflight);
  $('auto-interval').disabled=Boolean(active);
  if(!a)return;
  if(active){$('queue-rounds').value=String(a.rounds);if(Number.isInteger(a.interval_ms))$('auto-interval').value=String(a.interval_ms/1000);}
  $('queue-start').disabled=Boolean(active||a.inflight);
  $('queue-pause').disabled=a.status!=='running';$('queue-resume').disabled=!(a.status==='paused'||a.status==='stopped'&&a.inflight&&['receipt_missing','page_unavailable'].includes(a.last_error))||Boolean(a.inflight&&!['receipt_missing','page_unavailable'].includes(a.last_error));
  $('queue-resume').textContent=a.inflight&&['receipt_missing','page_unavailable'].includes(a.last_error)?'确认重试未确认任务':'继续';
  $('queue-stop').disabled=!active;
  $('queue-manual').disabled=Boolean(active);$('queue-rounds').disabled=Boolean(active);
  const labels={running:'自动收集中',paused:'自动收集已暂停',stopped:'自动收集已停止',completed:'设定轮次已完成，题库完整性未验证'};
  const errors={user_pause:'用户暂停',user_stop:'用户停止',http_401:'401，请检查登录',http_403:'403，访问被拒绝',http_429:'429，访问过于频繁',network_error:'网络异常',request_aborted:'请求取消或20秒超时',response_shape:'响应结构异常',response_size:'响应超限',transport_unverified:'无法确认请求状态或目标地址',client_unavailable:'原站请求客户端不可用，请刷新题库页面后继续',page_busy:'页面上一请求尚未结束',receipt_missing:'请求回执丢失，已暂停防止自动重放；可明确点击继续重试',page_unavailable:'原标签页文档已关闭或刷新，请打开题库页面后继续',rows_rejected:'部分题目未通过解析，任务保留待处理',storage_error:'本地存储失败，任务回执待恢复'};
  const task=stats.queue?.next,p=stats.queue?.progress||{observed:0,total:0,duplicates:0};
  const round=task?.round||a.rounds;
  const added=(stats.queue?.progress?.total? a.round_results.find(r=>r.round===round)?.added:null)??0;
  // Current round includes partial completed tasks; the coordinator provides totals from persistent tasks.
  const currentAdded=stats.automation_round_added??added;
  const types={one_choice:'单选',multi_choice:'多选',judge:'判断'};
  $('queue-status').textContent=(labels[a.status]||'未知状态')+`。当前章节 ${task?.chapter_id||'—'}，题型 ${types[task?.question_type]||'—'}，第 ${round}/${a.rounds} 轮；任务 ${p.observed}/${p.total}；本轮新增 ${currentAdded}，重复 ${p.duplicates}。`+
    (a.phase==='chapters'?'正在获取章节清单。':'')+
    '最近请求：'+(a.last_request_at?new Date(a.last_request_at).toLocaleString():'尚未请求')+'。最近错误：'+(storageLabels[stats.automation_error||a.last_error]||errors[stats.automation_error||a.last_error]||'无')+'。'+
    `计划 ${a.run_id||'—'}。`+(a.previous_run_id?`上次计划 ${a.previous_run_id}。`:'')+a.round_results.map(r=>`第 ${r.round} 轮新增 ${r.added}。`).join('');
}
const storageLabels={quota_exceeded:'存储容量不足',serialization:'数据序列化失败',write_denied:'存储写入被拒绝',storage_timeout:'存储操作超时，结果待确认',state_conflict:'任务状态或存储版本冲突',integrity_error:'数据完整性校验失败',read_failed:'存储读取失败',unknown_storage:'未知存储异常',migration_failed:'旧数据迁移校验失败',task_processing:'任务数据处理失败'};
function showStorage(stats){
  const d=stats.storage;
  $('recover-storage').disabled=!stats.automation?.inflight||stats.automation?.status==='running';
  if(!d){$('storage-diagnostic').textContent='存储诊断暂不可用';return;}
  const error=d.last_error;
  $('storage-diagnostic').textContent=`题目 ${stats.total}；本地使用量 ${Number.isFinite(d.usage_bytes)?(d.usage_bytes/1024/1024).toFixed(2)+' MiB':'未知'}；提交版本 ${d.revision}。`+
    '最近存储错误：'+(storageLabels[error?.code]||'无')+(error?.stage?'（阶段 '+error.stage+'）':'')+'。'+
    '最近成功保存：'+(d.last_success_at?new Date(d.last_success_at).toLocaleString():'尚未提交')+'。'+
    (d.pending_recovery?'存在待恢复任务/回执。':'无待恢复回执。')+
    '最近数据提交：'+(d.last_commit?.result==='failed'?'失败，未确认':d.revision?'已持久化':'尚无提交')+'。'+(d.legacy_backup_retained?'旧版题库备份保留。':'无旧版题库备份（新安装）。');
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
const diagnosticReasons={observer_missing:'隔离接收器存在，但 MAIN 监听器未应答',bridge_missing:'当前标签页未找到扩展接收器，请检查页面地址、网站访问权限并刷新网页',ready:'MAIN 监听器与隔离接收器握手成功',response_pending:'已收到指定接口响应',json:'响应不是可读取的 JSON',shape:'响应不符合 code:200 与 data 数组结构',size:'响应或题目超过安全大小限制',row_schema:'题目字段或接口上下文不符合白名单',endpoint_context:'接口路径正确，但手册/章节参数无效',http_status:'目标接口返回非成功 HTTP 状态',redirect:'响应最终地址与指定接口不一致',network:'页面原请求失败',unsupported_xhr:'XHR 使用了不支持的响应类型',bridge_rejected:'题目消息未通过扩展校验',queue_full:'待处理消息超过安全限制',saving:'等待后台确认写入',normalization:'题型、选项或答案规范化失败',storage_access:'扩展存储权限初始化失败',storage_read:'读取本地题库失败',storage_write:'本地写入失败，可能达到存储配额',background_unreachable:'后台未确认保存，可能需要重新加载扩展并刷新网页',saved:'后台已确认写入或重复题目合并',empty:'接口返回空题目数组',diagnostic_invalid:'未收到有效的诊断状态',hook_replaced:'页面后来替换了 fetch 或 XHR 监听函数，当前监听可能失效',handshake_pending:'正在进行 MAIN 双向握手（超时 2000 毫秒）',main_bootstrap_timeout:'2000 毫秒内未收到 MAIN bootstrap 回执；无法仅据此认定是 CSP',main_ack_timeout:'MAIN 已执行或 bootstrap 已出现，但未收到本轮 challenge 的匹配 ack',main_confirm_timeout:'收到 ack，但未收到双向确认，或监听器尚未就绪',main_core_missing:'MAIN bootstrap 已运行，但 core.js 未就绪',main_entities_missing:'MAIN bootstrap 已运行，但 entities.js 未就绪',main_observer_pending:'MAIN 依赖已就绪，但 observer.js 未完成初始化',main_observer_init_failed:'MAIN 监听器初始化抛出异常，未标记为已安装',main_fetch_patch_failed:'MAIN 已执行，但安装 fetch 监听时抛出异常',main_xhr_patch_failed:'MAIN 已执行，但安装 XHR 监听时抛出异常',main_csp_blocked:'Chrome 补注入明确报告 CSP 阻止执行',main_injection_denied:'Chrome 补注入被权限或浏览器策略拒绝，请检查扩展站点访问权限',main_document_gone:'Chrome 明确报告原文档或标签页已失效，未向新文档注入',main_document_unidentified:'Chrome 消息未提供可用的 documentId，已停止补注入以免指向错误页面',main_file_missing:'Chrome 无法加载扩展的 MAIN 脚本文件，请检查更新文件是否完整',main_injection_failed:'Chrome MAIN 补注入失败，无法安全归类；请查看扩展错误页',main_result_invalid:'Chrome 执行返回后未检测到预期的 MAIN 状态',ready_recovered:'双向握手成功，MAIN 经 Chrome scripting 补注入启动；启动前响应不会重放',none:''};
function showDiagnostic(d) {
  const valid=d && Object.hasOwn(diagnosticLabels,d.status) && Object.hasOwn(diagnosticReasons,d.reason);
  const safe=valid?d:{status:'not_injected',reason:'diagnostic_invalid'};
  $('diagnostic-status').textContent=safe.reason==='handshake_pending'?'MAIN 双向握手进行中（2 秒超时）':safe.status==='not_injected' && safe.reason.startsWith('main_')?'MAIN 启动或通信检查失败':safe.reason==='empty'?'已捕获响应，返回空题目数组':safe.reason==='network'?'监听已启动，但页面本次请求失败':diagnosticLabels[safe.status];
  const count=k=>Number.isSafeInteger(safe[k]) && safe[k]>=0?safe[k]:0;
  const h=safe.handshake;
  const phases={unseen:'未见 bootstrap',core_missing:'core 未就绪',entities_missing:'entities 未就绪',observer_pending:'监听器未完成',observer_init_failed:'初始化异常',fetch_patch_failed:'fetch 安装异常',xhr_patch_failed:'XHR 安装异常',installed:'监听器已安装',hook_replaced:'监听函数被替换',booting:'启动中'};
  const recovery=h?.recovery==='pending'?'Chrome 补注入仍在等待结果':h?.recovery==='main_injection_ok'?'Chrome 已确认补注入执行成功':'';
  const phase=Object.hasOwn(phases,h?.phase)?phases[h.phase]:'';
  const handshakeDetail=h && typeof h.bootstrapSeen==='boolean' && Number.isSafeInteger(h.attempt)?` 握手第 ${h.attempt} 轮，bootstrap ${h.bootstrapSeen?'已见':'未见'}，超时 2000 毫秒。${phase}。${recovery}`:'';
  $('diagnostic-detail').textContent=diagnosticReasons[safe.reason]+handshakeDetail+`。本标签页：捕获 ${count('captured')} 次响应，解析 ${count('parsed')} 条，保存/合并 ${count('saved')} 条，拒绝 ${count('rejected')} 条。`;
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
  if (area==='local' && ['questionBankV1','dhuBankHeadV2','dhuStorageFaultV2','dhuPendingReceiptV2'].some(k=>changes[k]) && !busy) void action(refresh);
});
void action(refresh);

// Local status polling only; never fetches or replays a question request.
setInterval(()=>{if(!busy)void diagnoseActiveTab();},1000);

for(const [id,command] of [['queue-start','start'],['queue-pause','pause'],['queue-resume','resume'],['queue-stop','stop']]) {
  $(id).addEventListener('click',()=>action(async()=>{
    const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
    const response=await send(automation&&(['running','paused'].includes(automation.status)||automation.inflight)?
      {kind:'auto_control',action:command,tab_id:tab?.id,...(command==='resume'&&automation.inflight&&['receipt_missing','page_unavailable'].includes(automation.last_error)?{retry_uncertain:true}:{})}:
      {kind:'queue_control',action:command,manual_id:$('queue-manual').value,rounds:Number($('queue-rounds').value)});
    showStats(response.stats);
  }));
}

$('auto-start').addEventListener('click',()=>action(async()=>{
  const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
  const response=await send({kind:'auto_start',tab_id:tab?.id,manual_id:$('queue-manual').value||null,
    rounds:Number($('queue-rounds').value),interval_seconds:Number($('auto-interval').value)});
  showStats(response.stats);
}));

$('recover-storage').addEventListener('click',()=>action(async()=>{const response=await send({kind:'auto_control',action:'recover'});showStats(response.stats);}));
