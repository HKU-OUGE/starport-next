import {initOperations} from './operations.js';
import {initShell} from './shell.js';
import {initRemoteSettings} from './remote.js';
import {initResources} from './resources.js';
import {initViewer} from './viewer.js';
import {initSessions} from './sessions.js';
const $=id=>document.getElementById(id);let status,csrf='',folder='',selected='',polling=false,connectionError=false,sdkRunning=false;
const errors={session_archived:'请先恢复归档会话。',session_busy:'会话正在运行。',session_context_unconfirmed_create_new:'上一轮没有取得可续接的上下文，请新建会话。',api_gateway_required:'请先配置 API。',session_stop_requires_reconciliation:'停止结果待核对，请刷新状态。',authentication_required:'请输入本机访问码。',workspace_verification_required:'请先完成工作区边界验证。',wsl_runtime_requires_windows:'当前主机不是 Windows；WSL2 实机验证待完成。',controlled_proxy_not_running:'受控代理未启动，请配置订阅和节点。',workspace_busy:'该项目正在执行操作，请稍后重试。',workspace_operations_active:'请等待当前工作区操作完成后再验证。',enable_controlled_egress_first:'请先配置并启用受控出口。'};
function problem(e){$('error').textContent=errors[e.message]||e.message;}
async function api(route,body){const r=await fetch(route,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body),cache:'no-store',signal:AbortSignal.timeout(body===undefined?30000:route.endsWith('/sdk')?360000:150000)});const v=await r.json();if(!r.ok)throw Error(v.error||'request_failed');return v;}
function el(tag,text,cls){const n=document.createElement(tag);if(text!==undefined)n.textContent=text;if(cls)n.className=cls;return n;}
const action=(button,fn)=>button.addEventListener('click',async()=>{button.disabled=true;$('error').textContent='';try{await fn();}catch(e){problem(e);}finally{button.disabled=false;}});
const shell=initShell();
const sessions=initSessions({api,problem,el});
const operations=initOperations({api,problem,action,el});
initRemoteSettings({api,problem,action});
initResources({api,problem,action});
const viewer=initViewer({api,action,problem,workspace:()=>selected});
Object.assign(errors,{close_existing_display_first:'请先关闭工作区应用，再切换打开方式。',remote_display_required:'请先在网页模式启动一个客户端。',viewer_already_connected:'该项目桌面已有连接，请先在原页面断开画面。'});
Object.assign(errors,{compute_unavailable:'计算连接暂时不可用。',compute_outcome_unknown_check_before_retry:'提交结果待核对，请勿重复提交。',job_already_finished:'任务已经结束。',job_operation_pending:'任务操作尚未返回，请稍后刷新。',service_registration_failed:'服务注册未完成，请检查本机日志。',artifact_integrity_mismatch:'下载校验失败，请重新获取产物。',panel_artifact_too_large_use_compute_client:'此产物超过 64 MiB，请使用项目计算客户端下载。'});
Object.assign(errors,{password_requires_12_to_1024_characters:'口令必须为 12 至 1024 个字符。',profile_password_or_integrity_failed:'口令不正确或配置包已损坏。',profile_destination_exists:'已有同名配置，请换一个名称。',configuration_preview_required:'请重新预览配置后再导入。',invalid_profile_name:'配置名称须以小写字母开头，只使用小写字母、数字和连字符，最多 48 字符。',encrypted_profile_required:'含连接或凭据的配置必须使用加密包。',configuration_operation_busy:'另一项配置操作正在进行，请稍后重试。'});
async function refresh(){if(polling)return;polling=true;try{status=await api('/api/status');if(connectionError){$('error').textContent='';connectionError=false;}csrf=status.csrf;$('startup').hidden=true;$('login').hidden=true;$('console').hidden=false;$('connection').textContent='已连接';$('connection').className='pill good';$('platform').textContent={win32:'Windows',linux:'Linux',darwin:'macOS'}[status.control.platform]||status.control.platform;$('egress').textContent=status.egress.enabled?'已连接':'已关闭';$('toggle-egress').textContent=status.egress.enabled?'暂停出口':'恢复出口';$('compute').textContent=`${status.compute.summary?.ready??0} / ${status.compute.summary?.configured??0} 就绪`;$('capacity').textContent=status.compute.summary?.ready?`${status.compute.summary.cpus} CPU · ${status.compute.summary.memory_gib} GiB · ${status.compute.summary.gpus} GPU`:'等待服务器连接';$('runtime').textContent=status.runtime.installed?'已安装':'待安装';$('updated').textContent='后台检查 '+(status.control.updatedAt?new Date(status.control.updatedAt).toLocaleTimeString():'—');
if(status.workspaces.join()!==[...$('workspace').options].map(o=>o.value).join()){const old=selected;$('workspace').replaceChildren(...status.workspaces.map(v=>{const o=el('option',v);o.value=v;return o;}));$('workspace').value=status.workspaces.includes(old)?old:status.workspaces[0];selected=$('workspace').value;}
const report=status.runtime.reports.find(r=>r.workspace===selected),busy=status.runtime.active.some(r=>r.workspace===selected&&['exec','sdk'].includes(r.operation));$('verified').textContent=report?.passed?'边界验证通过':'未验证';$('verified').className='pill'+(report?.passed?' good':'');$('run').disabled=!report?.passed||busy||sdkRunning;
$('open-folder').hidden=status.control.platform!=='win32'||status.control.remote!=='local';$('open-folder').disabled=!report?.passed;
$('configuration').hidden=status.control.remote!=='local';
viewer.update(status);
const remoteDisplay=$('client-display').value==='remote';$('native-note').textContent=remoteDisplay?'WSL2 项目桌面':'WSLg · 共享显示与剪贴板';
for(const name of ['browser','desktop','terminal','login','stop'])$('native-'+name).disabled=name==='stop'?false:!report?.passed||(!remoteDisplay&&!status.runtime.wslg);
$('clients-refresh').disabled=!report?.passed||busy||sdkRunning;$('sdk-run').disabled=sdkRunning||busy||!report?.passed||!status.model?.configured;
$('sdk-model').textContent=status.model?.configured?'模型：'+(status.model.model||'默认模型')+' · 按实际调用计费，未设置美元预算上限':'尚未配置 API Key；CLI 和 Desktop 的账号登录独立进行。';
operations.update(status);shell.update(status);sessions.update(status);
}catch(e){if(e.message==='authentication_required'){$('startup').hidden=true;$('login').hidden=false;$('console').hidden=true;$('connection').textContent='待登录';shell.logout();}else{connectionError=true;$('startup-state').textContent='连接暂时中断，正在重试。';$('connection').textContent='正在重连';$('connection').className='pill';$('error').textContent='控制端暂时不可达，正在重连。';}}finally{polling=false;}}
async function files(q){return api(`/api/workspaces/${selected}/files`,q);}
const joined=name=>folder?folder+'/'+name:name;
async function list(){const value=await files({operation:'list',path:folder});$('directory').textContent='/workspace'+(folder?'/'+folder:'');$('files').replaceChildren(...value.entries.map(f=>{const row=el('div',undefined,'file'),name=el('button',(f.directory?'▸ ':'')+f.name,'name quiet');row.append(name,el('small',f.directory?'文件夹':Math.ceil(f.bytes/1024)+' KiB'));action(name,async()=>{if(f.directory){folder=joined(f.name);await list();}else await download(f.name);});if(!f.symlink){const rename=el('button','改名','quiet'),del=el('button','删除','quiet');action(rename,async()=>{const n=prompt('新的文件名',f.name);if(!n)return;await files({operation:'rename',path:joined(f.name),destination:joined(n)});await list();});action(del,async()=>{if(!confirm(`删除 ${f.name}？`))return;await files({operation:'delete',path:joined(f.name)});await list();});row.append(rename,del);}return row;}));if(value.nextOffset!==null)$('files').append(el('p','本页显示 500 项；后续分页可通过文件 API 的 offset 查询。'));}
async function digest(bytes){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');}
async function download(name){const v=await files({operation:'read',path:joined(name)}),bytes=Uint8Array.from(atob(v.data),c=>c.charCodeAt(0));if(await digest(bytes)!==v.sha256)throw Error('file_integrity_mismatch');const url=URL.createObjectURL(new Blob([bytes])),a=el('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
$('login').addEventListener('submit',async e=>{e.preventDefault();try{await api('/api/login',{key:$('key').value});$('key').value='';await refresh();}catch(err){problem(err);}});
action($('refresh'),refresh);action($('files-refresh'),list);action($('parent'),async()=>{folder=folder.split('/').slice(0,-1).join('/');await list();});
action($('open-folder'),async()=>{await api(`/api/workspaces/${selected}/open-folder`,{});$('folder-opened').textContent='已请求打开当前项目文件夹。Windows 中的文件修改会同步到工作区。';});
action($('mkdir'),async()=>{const name=prompt('文件夹名称');if(name){await files({operation:'mkdir',path:joined(name)});await list();}});
action($('new-workspace'),async()=>{const id=prompt('项目名称（小写英文字母、数字和连字符）');if(id){await api('/api/workspaces',{id});await refresh();}});
action($('toggle-egress'),async()=>{await api('/api/egress/'+(status.egress.enabled?'pause':'resume'),{});await refresh();});
action($('verify'),async()=>{$('verified').textContent='验证中…';const v=await api(`/api/workspaces/${selected}/verify`,{});$('output').textContent=JSON.stringify(v,null,2);await refresh();});
$('workspace').addEventListener('change',()=>{selected=$('workspace').value;folder='';$('files').replaceChildren();refresh();list().catch(problem);});
$('execute').addEventListener('submit',async e=>{e.preventDefault();$('run').disabled=true;$('output').textContent='执行中…';try{const v=await api(`/api/workspaces/${selected}/exec`,{script:$('script').value});$('output').textContent=v.stdout+v.stderr+`\n退出码：${v.code}`;}catch(e){problem(e);}finally{await refresh();}});
$('upload').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;try{if(f.size>64*1024*1024)throw Error('单文件上限为 64 MiB');const bytes=new Uint8Array(await f.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));await files({operation:'write',path:joined(f.name),data:btoa(binary),sha256:await digest(bytes)});await list();}catch(e){problem(e);}finally{e.target.value='';}});
action($('clients-refresh'),async()=>{const v=await api(`/api/workspaces/${selected}/clients`,{});$('clients-output').textContent=`Node：${v.node||'未安装'}\nClaude Code：${v.claudeCode||'未安装'}\nAgent SDK：${v.agentSdk||'未安装'}\nClaude Desktop：${v.desktopInstalled?'已安装（请在应用内确认登录）':'未安装'}\n浏览器：${v.browser||'未安装'}\nClaude Code 账号：${v.account.loggedIn?'已登录':'待登录'}\n计算 MCP：Code ${v.computeMcp?.claudeCodeConfigured?'已配置':'未配置'} · Desktop ${v.computeMcp?.desktopConfigured?'已配置':'未配置'}\n项目计算指引：${v.computeMcp?.guidancePresent?'已就绪':'待配置'}\nMCP 配置状态不代表账号登录或真实对话验收。`;});
for(const app of ['browser','desktop','terminal','login','stop'])action($('native-'+app),async()=>{const display=$('client-display').value;await api(`/api/workspaces/${selected}/native`,{app,display});if(app==='stop'){viewer.disconnect();$('clients-output').textContent='工作区图形应用已关闭。';}else if(display==='remote'){await viewer.connect();$('clients-output').textContent='已在项目桌面打开。';}else $('clients-output').textContent='已打开 WSLg 窗口。';await refresh();});
$('client-display').addEventListener('change',refresh);
$('sdk-form').addEventListener('submit',async e=>{
  e.preventDefault();sdkRunning=true;$('sdk-run').disabled=true;$('clients-refresh').disabled=true;$('run').disabled=true;$('error').textContent='';$('sdk-output').textContent='任务运行中…';
  try{
    const r=await api(`/api/workspaces/${selected}/sdk`,{prompt:$('sdk-prompt').value});
    const events=r.stdout.trim().split('\n').filter(Boolean).map(line=>{try{return JSON.parse(line);}catch{return null;}}).filter(Boolean);
    const blocks=events.filter(v=>v.type==='assistant').map(v=>(v.message?.content||[]).filter(p=>p.type==='text').map(p=>p.text).join('\n')).filter(Boolean);
    const result=events.findLast(v=>v.type==='result');
    if(result?.is_error)blocks.push(result.errors?.join('\n')||result.result||JSON.stringify(result));
    else if(result?.result&&result.result!==blocks.at(-1))blocks.push(result.result);
    $('sdk-output').textContent=blocks.join('\n\n')||r.stderr||`退出码：${r.code}`;
  }catch(err){problem(err);$('sdk-output').textContent='任务请求未完成，请检查错误信息。';}
  finally{sdkRunning=false;await refresh();}
});
let importBundle,previewToken;
async function loadConfigurations(){const v=await api('/api/configuration'),old=$('config-source').value;const options=[];if(v.currentAvailable){const o=el('option','当前安装');o.value='current';options.push(o);}for(const p of v.profiles){const o=el('option',p.name+(p.encrypted?' · 已加密':''));o.value=p.name;options.push(o);}$('config-source').replaceChildren(...options);if(options.some(o=>o.value===old))$('config-source').value=old;$('config-count').textContent=`已保存 ${v.profiles.length} 份导入配置`;$('export-config').disabled=!options.length;}
function invalidatePreview(){previewToken=undefined;importBundle=undefined;$('import-config').disabled=true;$('config-preview').textContent='选择配置包并预览后可导入。';}
$('configuration').addEventListener('toggle',()=>{if($('configuration').open)loadConfigurations().catch(problem);});
action($('config-refresh'),loadConfigurations);
$('config-secrets').addEventListener('change',()=>{const enabled=$('config-secrets').checked;$('export-passwords').hidden=!enabled;for(const id of ['export-password','export-password-again']){$(id).required=enabled;if(!enabled)$(id).value='';}});
$('import-file').addEventListener('change',invalidatePreview);$('import-password').addEventListener('input',invalidatePreview);
action($('preview-config'),async()=>{
  invalidatePreview();const file=$('import-file').files[0];if(!file)throw Error('请选择配置包。');if(file.size>32*1024*1024)throw Error('配置包不能超过 32 MiB。');
  const value=JSON.parse(await file.text()),r=await api('/api/configuration/preview',{bundle:value,password:$('import-password').value});importBundle=value;previewToken=r.previewToken;
  const p=r.preview,lines=[`来源：${p.source}`,`模型：${r.model}`,`计算节点：${p.nodes.length}`,`网络订阅：${p.subscriptionCount}`,`包含私密项目：${p.includedSecretCount}`,`待补充凭据：${p.missingSecretRefs.length}`];
  for(const n of p.nodes)lines.push(`${n.id}：${n.transport} · ${n.budget.cpus} CPU · ${n.budget.memoryGiB} GiB · ${n.budget.gpus.length} GPU 配置上限`);
  if(r.computePolicy)lines.push(`并发任务数：${r.computePolicy.parallel===null?'不设固定上限':r.computePolicy.parallel}`);
  if(r.computePolicies)for(const [node,policy] of Object.entries(r.computePolicies))lines.push(`${node} 并发任务数：${policy.parallel===null?'不设固定上限':policy.parallel}`);
  if(r.defaultComputeNode!==undefined)lines.push(`默认服务器：${r.defaultComputeNode||'提交时选择'}`);
  lines.push('导入后：待安装／验证，不启动服务，不替换当前配置。');$('config-preview').textContent=lines.join('\n');$('import-config').disabled=false;
});
$('config-import').addEventListener('submit',async e=>{e.preventDefault();$('import-config').disabled=true;try{if(!previewToken)throw Error('configuration_preview_required');const r=await api('/api/configuration/import',{bundle:importBundle,password:$('import-password').value,name:$('import-name').value,previewToken});$('config-result').textContent=`配置“${r.name}”已保存，可在导出列表中选择。当前安装继续运行；新配置尚未激活。`;$('import-password').value='';$('import-file').value='';invalidatePreview();await loadConfigurations();}catch(e){problem(e);$('import-config').disabled=!previewToken;}});
$('config-export').addEventListener('submit',async e=>{e.preventDefault();$('export-config').disabled=true;try{const includeSecrets=$('config-secrets').checked;if(includeSecrets&&$('export-password').value!==$('export-password-again').value)throw Error('两次口令不一致。');const r=await api('/api/configuration/export',{source:$('config-source').value,includeSecrets,password:$('export-password').value});const url=URL.createObjectURL(new Blob([JSON.stringify(r.bundle,null,2)+'\n'],{type:'application/json'})),a=el('a');a.href=url;a.download=r.filename;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);$('config-result').textContent=r.encrypted?'加密配置包已生成并开始下载。请妥善保管口令。':'配置模板已生成并开始下载，不含连接地址和凭据。';$('export-password').value='';$('export-password-again').value='';}catch(e){problem(e);}finally{$('export-config').disabled=false;}});
document.addEventListener('starport:view',e=>{if(e.detail==='configuration'&&status?.control.remote==='local')loadConfigurations().catch(problem);});
await refresh();setInterval(refresh,5000);
