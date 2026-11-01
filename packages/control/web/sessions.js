const labels={idle:'就绪',running:'运行中',cancelling:'正在停止',completed:'已完成',cancelled:'已停止',interrupted:'已中断',failed:'失败'};
export function initSessions({api,problem,el}){
  const $=id=>document.getElementById(id),cache=new Map();
  let status,selected=sessionStorage.getItem('starport-session')||'',row,cursor=0,epoch=0,loading=false,sending=false,signature='';
  const visible=()=>location.hash==='#sessions';
  const busy=()=>['running','cancelling'].includes(row?.status);
  const key=id=>'starport-message-'+id;
  function pending(id){try{return JSON.parse(sessionStorage.getItem(key(id))||'null');}catch{return null;}}
  function controls(){
    const proof=status?.runtime.reports.find(r=>r.workspace===row?.workspace),ready=proof?.passed&&status?.model?.configured&&status?.egress.enabled;
    $('session-title').textContent=row?.title||'选择或新建会话';
    $('session-state').textContent=row?`${row.workspace} · ${labels[row.status]||row.status}${row.archived?' · 已归档':''}`:'';
    $('session-model').textContent=row?.model||status?.model?.model||'API 未配置';
    $('session-send').disabled=!row||busy()||sending||row.archived||!ready;
    $('session-input').disabled=!row||row.archived||sending;
    $('session-stop').hidden=!busy();$('session-stop').disabled=row?.status==='cancelling';
    $('session-rename').disabled=!row;$('session-archive').disabled=!row||busy();
    $('session-archive').textContent=row?.archived?'恢复':'归档';
    $('session-send').textContent=sending?'发送中…':pending(selected)?'重试发送':'发送';
  }
  function card(label,text,kind='assistant'){
    const node=el('article',undefined,'chat-message chat-'+kind);node.append(el('div',label,'chat-label'),el('div',text,'chat-text'));return node;
  }
  function tool(label,value){const details=el('details',undefined,'chat-tool');details.append(el('summary',label),el('pre',typeof value==='string'?value:JSON.stringify(value,null,2)));return details;}
  function renderEvent(item){
    const nodes=[];
    if(item.type==='prompt')nodes.push(card('你',item.prompt,'user'));
    if(item.type==='state'&&item.status!=='completed')nodes.push(card(labels[item.status]||item.status,item.message||item.error||'','state'));
    const event=item.event;
    if(event?.type==='assistant')for(const part of event.message?.content||[]){
      if(part.type==='text')nodes.push(card('Claude',part.text));
      if(part.type==='tool_use')nodes.push(tool(part.name,part.input));
    }
    if(event?.type==='user')for(const part of Array.isArray(event.message?.content)?event.message.content:[]){if(part.type==='tool_result')nodes.push(tool(part.is_error?'工具错误':'工具结果',part.content));}
    if(event?.type==='result'){
      if(event.is_error)nodes.push(card('调用未完成',(event.errors||[]).join('\n')||event.result||event.subtype,'state'));
      nodes.push(el('div',`${event.is_error?'已结束':'本轮完成'}${Number.isFinite(event.total_cost_usd)?' · 会话累计估算 $'+event.total_cost_usd.toFixed(4):''}`,'chat-result'));
    }
    return nodes;
  }
  function drafts(){if(selected&&!sending)cache.set(selected,$('session-input').value);}
  async function choose(id){
    drafts();selected=id;sessionStorage.setItem('starport-session',id);row=undefined;cursor=0;epoch++;
    $('session-name-form').hidden=true;$('session-messages').replaceChildren();$('session-input').value=pending(id)?.prompt||cache.get(id)||'';controls();await sync();
  }
  async function sync(){
    if(!status||!visible()||loading)return;loading=true;const generation=epoch;
    try{
      const {sessions:list}=await api('/api/sessions?workspace='+encodeURIComponent($('session-workspace').value)+'&archived='+($('session-filter').value==='archived'));
      if(generation!==epoch)return;
      const sig=JSON.stringify(list.map(s=>[s.id,s.title,s.status,s.updatedAt]))+selected;
      if(sig!==signature){signature=sig;$('session-list').replaceChildren(...list.map(s=>{
        const button=el('button',undefined,'session-item quiet'+(s.id===selected?' selected':''));
        button.setAttribute('aria-pressed',String(s.id===selected));button.append(el('strong',s.title),el('span',`${s.workspace} · ${labels[s.status]||s.status}`));
        button.addEventListener('click',()=>choose(s.id).catch(problem));return button;
      }));if(!list.length)$('session-list').append(el('p','暂无会话','empty-state'));}
      if(!selected)return;
      const data=await api('/api/sessions/'+selected+'?after='+cursor);if(generation!==epoch)return;
      row=data.session;const box=$('session-messages'),follow=box.scrollHeight-box.scrollTop-box.clientHeight<100||cursor===0;
      if(cursor===0&&!data.events.length&&!box.querySelector('.empty-state'))box.append(el('p','从一条消息开始','empty-state'));
      if(data.events.length)for(const empty of box.querySelectorAll('.empty-state'))empty.remove();
      for(const item of data.events)box.append(...renderEvent(item));cursor=data.nextCursor;
      const draft=pending(selected);if(draft&&row.turns.some(t=>t.id===draft.requestId)){sessionStorage.removeItem(key(selected));if($('session-input').value===draft.prompt)$('session-input').value='';cache.delete(selected);}
      if(follow)box.scrollTop=box.scrollHeight;controls();
      if(data.hasMore)setTimeout(()=>sync().catch(problem),0);
    }finally{loading=false;}
  }
  function action(id,fn){let active=false;$(id).addEventListener('click',async()=>{if(active)return;active=true;$(id).disabled=true;try{$('error').textContent='';await fn();}catch(e){problem(e);}finally{active=false;$(id).disabled=false;controls();}});}
  action('session-new',async()=>{
    const request=JSON.parse(sessionStorage.getItem('starport-create-session')||'null')||{workspace:$('session-workspace').value||status.workspaces[0],title:'新会话',requestId:crypto.randomUUID()};
    sessionStorage.setItem('starport-create-session',JSON.stringify(request));
    const created=await api('/api/sessions',request);sessionStorage.removeItem('starport-create-session');$('session-filter').value='active';await choose(created.id);$('session-input').focus();
  });
  action('session-rename',async()=>{$('session-name').value=row?.title||'';$('session-name-form').hidden=false;$('session-name').focus();});
  action('session-name-cancel',async()=>{$('session-name-form').hidden=true;});
  $('session-name-form').addEventListener('submit',async event=>{event.preventDefault();try{await api('/api/sessions/'+selected,{title:$('session-name').value});$('session-name-form').hidden=true;await sync();}catch(e){problem(e);}});
  action('session-archive',async()=>{await api('/api/sessions/'+selected,{archived:!row.archived});await sync();});
  action('session-stop',async()=>{await api('/api/sessions/'+selected+'/stop',{});await sync();});
  $('session-workspace').addEventListener('change',()=>sync().catch(problem));$('session-filter').addEventListener('change',()=>sync().catch(problem));
  $('session-input').addEventListener('input',drafts);
  $('session-form').addEventListener('submit',async event=>{
    event.preventDefault();if(!row||sending||busy()||row.archived)return;
    const id=selected,prompt=$('session-input').value;if(!prompt.trim())return;
    let request=pending(id);
    if(request&&request.prompt!==prompt){problem(Error('上次发送结果尚待核对，请保留原消息重试，或切换到新会话。'));return;}
    request||={prompt,requestId:crypto.randomUUID()};sessionStorage.setItem(key(id),JSON.stringify(request));sending=true;controls();
    try{$('error').textContent='';await api('/api/sessions/'+id+'/messages',request);sessionStorage.removeItem(key(id));cache.delete(id);if(selected===id)$('session-input').value='';await sync();}
    catch(e){problem(e);}finally{sending=false;controls();}
  });
  $('session-input').addEventListener('keydown',e=>{if(e.key==='Enter'&&(e.ctrlKey||e.metaKey)){e.preventDefault();$('session-form').requestSubmit();}});
  document.addEventListener('starport:view',e=>{if(e.detail==='sessions')sync().catch(problem);});
  setInterval(()=>sync().catch(problem),1200);
  return {update(value){status=value;const select=$('session-workspace');
    if(select.options.length!==value.workspaces.length+1){const old=select.value;select.replaceChildren(el('option','全部项目'),...value.workspaces.map(w=>{const o=el('option',w);o.value=w;return o;}));select.options[0].value='';select.value=old;}
    controls();if(visible())sync().catch(problem);
  }};
}
