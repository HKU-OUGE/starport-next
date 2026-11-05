const $=id=>document.getElementById(id);
const finished=new Set(['completed','failed','cancelled','canceled']);
const labels={running:'运行中',queued:'排队中',starting:'启动中',submitted:'已提交',completed:'已完成',failed:'失败',cancelled:'已取消',canceled:'已取消',unknown:'待核对',retrying:'重试中',stopped:'已停止',conflict:'端口冲突'};
const phase=j=>j.outcomeUnknown?'unknown':j.status||'submitted';
export function jobTimestamp(value){
  const n=typeof value==='number'?(value<1e12?value*1000:value):Date.parse(value);
  return Number.isFinite(n)?n:0;
}
export function selectJobs(rows,{search='',project='',node='',filter=''}={}){
  search=search.trim().toLowerCase();
  return rows.filter(j=>(!node||j.node===node)&&(!project||j.workspace===project)&&(!search||[j.id,j.config?.entry,j.workspace,j.node].join(' ').toLowerCase().includes(search))&&
    (!filter||(filter==='active'?!j.outcomeUnknown&&!finished.has(j.status):filter==='unknown'?j.outcomeUnknown:filter==='cancelled'?['cancelled','canceled'].includes(j.status):j.status===filter)))
    .sort((a,b)=>jobTimestamp(b.created_at||b.submittedAt)-jobTimestamp(a.created_at||a.submittedAt));
}
const time=v=>jobTimestamp(v)?new Date(jobTimestamp(v)).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'}):'—';
const size=n=>Number.isFinite(n)?n<1024?n+' B':n<1048576?(n/1024).toFixed(1)+' KiB':(n/1048576).toFixed(1)+' MiB':'—';
export function initOperations({api,problem,action,el}) {
  let rows=[],current,serviceState,detailId,detailEpoch=0,cursor=0,loadingJobs=false,lastSync=0,lastService=0,renderKey='',canCancel=false;
  const bind=(button,fn)=>action(button,async()=>{try{await fn();}catch(e){if($('job-detail').open)$('detail-message').textContent=e.message;throw e;}});
  const badge=(text,state)=>el('span',text,'status-badge status-'+state);
  const nodeName=id=>current?.compute.nodes?.find(n=>n.id===id)?.name||id||'—';
  const allocated=(node,key)=>rows.filter(j=>j.node===node&&!j.resources_released&&!j.outcomeUnknown).reduce((sum,j)=>sum+(Number(j.config?.[key])||0),0);
  function overview(){
    $('overview-status').replaceChildren(...[
      ['服务器',`${current?.compute.summary?.ready??0} 台就绪`],['任务',`${rows.filter(j=>!j.resources_released&&!j.outcomeUnknown).length} 项进行中`],
      ['登录启动',serviceState?.startup?.enabled?'已启用':serviceState?.supported?'未启用':'—']
    ].map(([label,value])=>{const item=el('div');item.append(el('span',label),el('strong',value));return item;}));
  }
  function renderNodes(){
    const nodes=current?.compute.nodes||[],search=$('node-search').value.trim().toLowerCase(),filter=$('node-state').value;
    const selected=nodes.filter(n=>(!search||[n.id,n.name].join(' ').toLowerCase().includes(search))&&(!filter||(filter==='ready'?n.ready&&!n.paused:filter==='paused'?n.paused:!n.ready)));
    $('node-count').textContent=String(nodes.length);$('nodes-empty').hidden=selected.length>0;$('nodes-empty').textContent=nodes.length?'没有匹配的服务器':'尚未接入服务器';
    $('nodes').replaceChildren(...selected.map(n=>{
      const row=el('tr'),name=el('td',n.name),state=el('td'),controls=el('td');name.append(el('code',n.id,'cell-sub'));
      state.append(badge(n.paused?'暂停接单':n.ready?'就绪':n.removed?'已移除':'需检查',n.paused?'queued':n.ready?'running':'failed'));
      if(n.error)state.title=n.error;
      const values=[['cpus','server_max_cpus'],['memory_gib','server_max_memory_gib'],['gpus','server_max_gpus']].map(([key,limit])=>{
        const value=el('td',`${allocated(n.id,key)} / ${n.ready?n.limits?.[limit]??'—':'—'}`,'numeric');
        value.title=`配置上限 ${n.configuredLimits?.[key]??'—'}`;return value;
      });
      const tasks=el('button','任务','quiet');tasks.addEventListener('click',()=>{$('job-node').value=n.id;renderJobs();location.hash='tasks';});controls.append(tasks);
      if(!n.removed){const toggle=el('button',n.paused?'恢复接单':'暂停接单','quiet');action(toggle,async()=>{await api(`/api/nodes/${n.id}/admission`,{paused:!n.paused});await syncNodes();});controls.append(toggle);}
      row.append(name,state,...values,controls);return row;
    }));overview();
  }
  async function syncNodes(){const value=await api('/api/nodes');current.compute={...current.compute,...value};renderNodes();renderJobs();}
  function renderJobs(){
    const search=$('job-search').value.trim().toLowerCase(),project=$('job-project').value,filter=$('job-state').value,node=$('job-node').value;
    const selected=selectJobs(rows,{search,project,filter,node});
    $('job-count').textContent=String(rows.length);
    $('jobs-empty').hidden=selected.length>0;$('jobs-empty').textContent=rows.length?'没有匹配的任务':'暂无任务';
    $('jobs').replaceChildren(...selected.map(j=>{
      const tr=el('tr'),name=el('td'),id=el('code',j.id.slice(0,10));id.title=j.id;name.append(id,el('span',j.config?.entry||'—','cell-sub'));
      const state=el('td');state.append(badge(labels[phase(j)]||phase(j),phase(j)));
      const config=j.config,resources=config?`${config.cpus??'—'} / ${config.memory_gib??'—'} GiB / ${config.gpus??'—'}`:'—';
      const controls=el('td'),open=el('button','查看','quiet');open.disabled=!!j.outcomeUnknown;action(open,()=>openDetail(j.id));controls.append(open);
      tr.append(name,el('td',nodeName(j.node)),el('td',j.workspace),state,el('td',resources,'numeric'),el('td',time(j.created_at||j.submittedAt)),controls);return tr;
    }));
    const scoped=rows.filter(j=>!node||j.node===node),active=scoped.filter(j=>!j.outcomeUnknown&&!finished.has(j.status));
    $('job-summary').replaceChildren(...[
      [active.length,'进行中'],[scoped.filter(j=>j.status==='completed').length,'已完成'],[scoped.filter(j=>j.status==='failed').length,'失败'],[scoped.filter(j=>j.outcomeUnknown).length,'待核对']
    ].map(([n,label])=>{const s=el('span');s.append(el('strong',String(n)),document.createTextNode(' '+label));return s;}));
    const used=scoped.filter(j=>!j.outcomeUnknown&&!j.resources_released),nodes=(current?.compute.nodes||[]).filter(n=>(!node||n.id===node)&&!n.removed);
    $('resource-summary').replaceChildren(...[['CPU','cpus','server_max_cpus','核'],['内存','memory_gib','server_max_memory_gib','GiB'],['GPU','gpus','server_max_gpus','卡']].map(([label,key,limit,unit])=>{
      const box=el('div',undefined,'resource-item');
      const allocated=used.reduce((sum,j)=>sum+(Number(j.config?.[key])||0),0),missing=used.some(j=>j.config?.[key]===undefined);
      const available=nodes.filter(n=>n.ready).reduce((sum,n)=>sum+(Number(n.limits?.[limit])||0),0),configured=nodes.reduce((sum,n)=>sum+(Number(n.configuredLimits?.[key])||0),0);
      box.append(el('span',label+(node?'':' · 合计')),el('strong',`${available} ${unit}`),el('span',`配置 ${configured} · 已申请 ${allocated}${missing?' + ?':''}`,'resource-meta'));return box;
    }));
  }
  async function syncJobs(){
    if(loadingJobs)return;loadingJobs=true;$('jobs-refresh').disabled=true;
    try{const value=await api('/api/jobs/refresh',{});rows=value.jobs;lastSync=Date.now();$('jobs-updated').textContent=value.failures.length?`${value.failures.length} 项未同步`:'已同步 '+new Date().toLocaleTimeString();renderJobs();renderNodes();}
    finally{loadingJobs=false;$('jobs-refresh').disabled=false;}
  }
  async function loadLogs(epoch=detailEpoch){
    const id=detailId,v=await api(`/api/jobs/${id}/logs?cursor=${cursor}`);
    if(epoch!==detailEpoch||id!==detailId)return;
    const previous=cursor?$('job-logs').textContent:'';
    $('job-logs').textContent=(previous+(v.text||'')).slice(-262144)||'暂无日志';
    const next=v.next_cursor??v.cursor;if(Number.isSafeInteger(next)&&next>=cursor)cursor=next;
    $('logs-more').disabled=v.done===true&&!v.truncated;
  }
  async function downloadArtifact(id,artifact){
    if(artifact.bytes>64*1024*1024)throw Error('大于 64 MiB 的产物请使用项目计算客户端下载。');
    const r=await fetch(`/api/jobs/${id}/artifact?path=${encodeURIComponent(artifact.path)}`,{cache:'no-store',signal:AbortSignal.timeout(180000)});
    if(!r.ok){let v;try{v=await r.json();}catch{}throw Error(v?.error||'artifact_download_failed');}
    const bytes=await r.arrayBuffer(),hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(v=>v.toString(16).padStart(2,'0')).join('');
    if(bytes.byteLength!==artifact.bytes||hash!==r.headers.get('x-content-sha256')||artifact.sha256&&hash!==artifact.sha256)throw Error('artifact_integrity_mismatch');
    const url=URL.createObjectURL(new Blob([bytes])),a=el('a');a.href=url;a.download=artifact.path.split('/').at(-1);a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  async function loadDetail(epoch=detailEpoch){
    const id=detailId,v=await api('/api/jobs/'+id);if(epoch!==detailEpoch||id!==detailId)return;
    rows=rows.map(j=>j.id===id?v:j);renderJobs();
    $('detail-title').textContent=v.config?.entry||id.slice(0,10);
    $('detail-facts').replaceChildren(badge(labels[phase(v)]||phase(v),phase(v)),el('code',v.id),el('span',nodeName(v.node)),el('span',v.workspace),
      el('span',`${v.config?.cpus??'—'} CPU · ${v.config?.memory_gib??'—'} GiB · ${v.config?.gpus??'—'} GPU`),
      el('span',`开始 ${time(v.started_at)} · 结束 ${time(v.finished_at)}`),el('span',`退出码 ${v.exit_code??'—'} · ${v.resources_released?'资源已释放':'资源未释放'}`));
    canCancel=!v.resources_released&&!v.outcomeUnknown;$('job-cancel').disabled=!canCancel;
    $('detail-message').textContent=v.error||'';
    $('job-artifacts').replaceChildren(...(v.artifacts?.length?v.artifacts.map(a=>{
      const row=el('div',undefined,'artifact-row'),download=el('button','下载','quiet');bind(download,()=>downloadArtifact(id,a));row.append(el('code',a.path),el('span',size(a.bytes)),download);return row;
    }):[el('p',v.resources_released?'无产物':'任务结束后可下载产物')]));
  }
  async function openDetail(id){
    detailId=id;const epoch=++detailEpoch;cursor=0;$('detail-title').textContent=id.slice(0,10);$('job-logs').textContent='加载中…';$('detail-facts').replaceChildren();$('job-artifacts').replaceChildren();$('detail-message').textContent='';$('job-cancel').disabled=true;$('logs-more').disabled=false;
    $('job-detail').showModal();await loadDetail(epoch);await loadLogs(epoch);
  }
  async function syncServices(){
    if(current?.control.remote!=='local')return;
    serviceState=await api('/api/services');lastService=Date.now();
    $('startup-toggle').disabled=!serviceState.supported;
    $('supervisor-start').disabled=!serviceState.supported||serviceState.supervisor?.phase==='running'||!serviceState.startup?.registered;
    $('startup-status').textContent=!serviceState.supported?'当前平台不支持':serviceState.error?'注册状态不可用':serviceState.startup.enabled?'登录启动已启用':'登录启动未启用';
    $('startup-toggle').textContent=serviceState.startup?.enabled?'禁用登录启动':'启用登录启动';
    const registered=serviceState.startup?.enabled,known=serviceState.services||[];
    const serviceRows=[['服务管理',serviceState.supervisor?.phase||'stopped',registered?'当前用户登录':'手动',current.control.platform==='linux'?'systemd 用户服务':'Windows'],
      ['控制面板','running',registered?'守护恢复':'手动','受控出口'],
      ...(current?.compute.nodes||[]).filter(n=>!n.removed).map(n=>[n.name,known.find(s=>s.id==='compute-'+n.id||n.id==='primary'&&s.id==='compute')?.phase||(n.ready?'running':'unknown'),known.some(s=>s.id==='compute-'+n.id||n.id==='primary'&&s.id==='compute')&&registered?'守护恢复':'独立运行','计算连接']),
      [current?.runtime.kind==='qemu'?'QEMU 工作区':'WSL2 工作区',current?.runtime.installed?'installed':'stopped','按需启动','边界验证']];
    $('services').replaceChildren(...serviceRows.map(([name,state,mode,dependency])=>{const tr=el('tr'),td=el('td');td.append(badge(state==='installed'?'已安装':labels[state]||state,state));tr.append(el('td',name),td,el('td',mode),el('td',dependency));return tr;}));
    overview();
  }
  for(const id of ['job-search','job-project','job-state','job-node'])$(id).addEventListener(id==='job-search'?'input':'change',renderJobs);
  $('node-search').addEventListener('input',renderNodes);$('node-state').addEventListener('change',renderNodes);action($('nodes-refresh'),syncNodes);
  action($('jobs-refresh'),syncJobs);action($('services-refresh'),syncServices);
  action($('startup-toggle'),async()=>{
    const actionName=serviceState?.startup?.enabled?'disable':'enable';
    await api('/api/services/'+actionName,{});await syncServices();
  });
  action($('supervisor-start'),async()=>{await api('/api/services/start',{});$('startup-status').textContent='已请求启动';setTimeout(()=>syncServices().catch(problem),12000);});
  $('detail-close').addEventListener('click',()=>$('job-detail').close());
  $('job-detail').addEventListener('close',()=>{detailId=undefined;detailEpoch++;});
  bind($('logs-more'),()=>loadLogs());bind($('detail-refresh'),async()=>{await loadDetail();await loadLogs();});
  $('job-cancel').addEventListener('click',async()=>{
    const id=detailId;if(!confirm('取消此任务？'))return;
    $('job-cancel').disabled=true;
    try{await api(`/api/jobs/${id}/cancel`,{});$('detail-message').textContent='已请求取消，等待资源释放。';await loadDetail();}
    catch(e){canCancel=false;$('detail-message').textContent='取消结果未确认，请刷新状态后核对。';problem(e);}
    finally{$('job-cancel').disabled=!canCancel;}
  });
  return {update(status){
    current=status;rows=status.jobs;
    $('service-center').hidden=status.control.remote!=='local';
    const project=$('job-project').value;
    if(status.workspaces.join()!==[...$('job-project').options].slice(1).map(o=>o.value).join()){
      const all=el('option','全部项目');all.value='';$('job-project').replaceChildren(all,...status.workspaces.map(w=>{const o=el('option',w);o.value=w;return o;}));$('job-project').value=project;
    }
    const node=$('job-node').value,nodes=status.compute.nodes||[];
    if(nodes.map(n=>n.id+':'+n.name).join()!==[...$('job-node').options].slice(1).map(o=>o.value+':'+o.textContent).join()){
      const all=el('option','全部服务器');all.value='';$('job-node').replaceChildren(all,...nodes.map(n=>{const o=el('option',n.name);o.value=n.id;return o;}));$('job-node').value=nodes.some(n=>n.id===node)?node:'';
    }
    const key=JSON.stringify([rows,status.compute]);if(key!==renderKey){renderKey=key;renderJobs();renderNodes();}
    if(!document.hidden&&Date.now()-lastSync>30000){lastSync=Date.now();syncJobs().catch(problem);}
    if(Date.now()-lastService>20000){lastService=Date.now();syncServices().catch(problem);}
  }};
}
