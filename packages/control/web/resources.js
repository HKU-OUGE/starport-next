const $=id=>document.getElementById(id);
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
const phases={publishing:'发布中',ready:'可用',disabled:'已停用',failed:'失败'};
const errors={resource_external_symlink:'存在指向目录外部的软链接',resource_sensitive_entry_review_required:'发现凭据或配置文件，请整理后重试',resource_changed:'发布时源目录发生变化',resource_publication_interrupted:'发布进程中断，请核对后重新发布',resource_nested_mount_not_allowed:'目录包含其他挂载点',resource_source_too_broad:'请选择具体环境或数据目录',resource_source_forbidden:'此目录不能作为复用来源'};
export function initResources({api,problem,action}){
  let loading=false,active=false,requestId,loadFailed=false,lastCatalog='';
  function loadProblem(e){loadFailed=true;$('resource-result').textContent='读取失败：'+(errors[e.message]||e.message);}
  async function loadNodes(){
    const v=await api('/api/nodes'),old=$('resource-node').value;
    $('resource-node').replaceChildren(...v.nodes.filter(n=>!n.removed).map(n=>{const o=el('option',n.name);o.value=n.id;return o;}));
    if(v.nodes.some(n=>n.id===old))$('resource-node').value=old;else if(v.defaultNode)$('resource-node').value=v.defaultNode;
  }
  async function load(){
    if(loading)return;loading=true;
    try{
      if(!$('resource-node').value)await loadNodes();
      const node=$('resource-node').value;
      if(!node){$('resources-empty').hidden=false;$('resources').replaceChildren();return;}
      const v=await api('/api/resources?node='+encodeURIComponent(node));
      if(node!==$('resource-node').value)return;
      if(loadFailed){$('resource-result').textContent='';loadFailed=false;}
      const catalogKey=JSON.stringify(v);if(catalogKey===lastCatalog)return;lastCatalog=catalogKey;
      $('resources-count').textContent=v.resources.filter(r=>r.phase==='ready').length+' 可用';
      $('resources-empty').hidden=!!v.resources.length;
      $('resources').replaceChildren(...v.resources.map(r=>{
        const row=el('tr'),name=el('td'),status=el('td'),version=el('td'),operations=el('td');
        name.append(el('strong',r.name),el('code',r.path));
        const badge=el('span',phases[r.phase]||r.phase);badge.className='pill '+(r.phase==='ready'?'good':'');status.append(badge);
        if(r.kind==='python')status.append(el('span','兼容性未验证'));
        if(r.error)status.append(el('span',errors[r.error]||r.error));
        if(r.embedded_source_paths)status.append(el('span','文件含原始路径'));
        version.append(el('code',r.version?r.version.slice(0,12):'—'),el('span',r.bytes===undefined?'—':r.bytes===0?'空目录':(r.bytes/1024**2).toFixed(1)+' MiB'));
        const copy=el('button','复制引用');copy.className='quiet';copy.disabled=r.phase!=='ready';
        action(copy,async()=>{await navigator.clipboard.writeText(JSON.stringify({node,mounts:[{id:r.id,version:r.version}]}));$('resource-result').textContent='已复制任务引用';});
        const disable=el('button','停用');disable.className='quiet';disable.disabled=['disabled','publishing'].includes(r.phase);
        action(disable,async()=>{await api('/api/resources/disable',{node,id:r.id});$('resource-result').textContent='已停用；已提交任务继续使用原版本';await load();});
        operations.append(copy,disable);row.append(name,el('td',r.kind==='python'?'Python / Conda':'数据 / 模型'),status,version,operations);return row;
      }));
    }finally{loading=false;}
  }
  document.addEventListener('starport:view',e=>{active=e.detail==='dependencies';if(active)load().catch(loadProblem);});
  $('resource-node').addEventListener('change',()=>{requestId=undefined;lastCatalog='';$('resource-result').textContent='';$('resources').replaceChildren();load().catch(loadProblem);});
  action($('resources-refresh'),load);
  action($('resource-auto-conda'),async()=>{
    const v=await api('/api/resources/auto-conda',{node:$('resource-node').value,reviewed:true});
    $('resource-result').textContent=v.found?`发现 ${v.found} 个环境，新增 ${v.created} 个；失败 ${v.failures.length} 个`:'未发现 Conda 环境，可用「新建复用」填写目录';
    await load();
  });
  $('resource-new').addEventListener('click',()=>{$('resource-editor').open=!$('resource-editor').open;if($('resource-editor').open)$('resource-name').focus();});
  $('resource-form').addEventListener('input',()=>{requestId=undefined;});
  $('resource-form').addEventListener('submit',async e=>{
    e.preventDefault();$('resource-save').disabled=true;$('resource-result').textContent='';
    requestId??=crypto.randomUUID().replaceAll('-','');
    try{
      const r=await api('/api/resources',{node:$('resource-node').value,id:requestId,name:$('resource-name').value.trim(),kind:$('resource-kind').value,source:$('resource-source').value.trim(),reviewed:$('resource-reviewed').checked});
      $('resource-result').textContent='已登记';$('resource-editor').open=false;$('resource-form').reset();requestId=undefined;await load();
    }catch(e){
      if(/outcome_unknown|resource_id_exists/.test(e.message))$('resource-result').textContent='结果待核对：'+requestId+'。请刷新列表，不要重复登记。';
      else problem(Error(errors[e.message]||e.message));
    }finally{$('resource-save').disabled=false;}
  });
  setInterval(()=>{if(active)load().catch(loadProblem);},8000);
}
