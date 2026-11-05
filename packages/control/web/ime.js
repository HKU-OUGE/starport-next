const $=id=>document.getElementById(id);
const modes={traditional:'繁体',english:'EN',simplified:'简体'};
const phases={not_started:'随应用启动',unavailable:'未安装',preparing:'词库准备中',ready:'就绪',failed:'需检查',reconnecting:'正在恢复',stopped:'已停止'};
export function initIme({api,action,workspace}){
  let selected='',current,pending=false;
  const send=async(actionName,settings)=>{pending=true;render();try{return await api(`/api/workspaces/${workspace()}/ime`,{action:actionName,...(settings?{settings}:{})});}finally{pending=false;render();}};
  function render(){
    const ime=current?.ime,active=current?.phase==='running';
    $('ime-status').textContent=(phases[ime?.phase||'not_started']||'需检查')+(ime?.mode?' · '+modes[ime.mode]:'');
    $('ime-status').className='pill'+(ime?.phase==='ready'?' good':'');
    $('ime-mode').disabled=pending||!active||ime?.phase!=='ready';
    if(document.activeElement!==$('ime-mode'))$('ime-mode').value=ime?.mode||'';
    $('ime-restart').disabled=pending||!active;
    $('ime-save').disabled=pending||!active;
  }
  $('ime-mode').addEventListener('change',async()=>{if(!$('ime-mode').value)return;try{const result=await send($('ime-mode').value);current.ime=result;$('ime-message').textContent='已更新最近使用的应用输入框。';}catch(e){$('ime-message').textContent=e.message==='ime_focus_required'?'请先在应用内点选一个文本输入框。':e.message==='ime_not_ready'?'输入法尚未就绪。':'输入法切换未完成，请刷新状态后核对。';}render();});
  action($('ime-restart'),async()=>{current.ime=await send('restart');$('ime-message').textContent=current.ime.phase==='ready'?'输入法已恢复；应用保持运行。':'输入法仍需检查。';render();});
  action($('ime-save'),async()=>{current.ime=await send('settings',{hotkey:$('ime-hotkey').value,rememberWindows:$('ime-remember').checked});$('ime-message').textContent='设置已保存，当前未确认的拼音已取消。';render();});
  return {update(status){current=status.runtime.native.find(n=>n.workspace===workspace());if(selected!==workspace()){selected=workspace();$('ime-message').textContent='';$('ime-settings').open=false;$('ime-hotkey').value=current?.ime?.hotkey||'Control+space';$('ime-remember').checked=current?.ime?.rememberWindows!==false;}if(!$('ime-settings').open){$('ime-hotkey').value=current?.ime?.hotkey||'Control+space';$('ime-remember').checked=current?.ime?.rememberWindows!==false;}render();}};
}
