export function initViewer({api,action,problem,workspace}){
  const $=id=>document.getElementById(id);let rfb,project;
  function disconnect(){rfb?.disconnect();rfb=undefined;project=undefined;$('viewer-box').hidden=true;$('viewer-box').classList.remove('viewer-expanded');$('viewer-fullscreen').textContent='展开画面';}
  async function connect(){
    const id=workspace();if(rfb&&project===id){$('viewer-box').scrollIntoView({block:'start'});return;}
    disconnect();const {ticket}=await api(`/api/workspaces/${id}/viewer-ticket`,{});
    const {default:RFB}=await import('/novnc/core/rfb.js');
    $('viewer-box').hidden=false;$('viewer-state').textContent='连接中';project=id;
    const socket=new URL(`/api/workspaces/${id}/viewer`,location.href);socket.protocol=location.protocol==='https:'?'wss:':'ws:';socket.searchParams.set('ticket',ticket);
    const client=new RFB($('viewer-screen'),socket.href);rfb=client;client.scaleViewport=true;client.resizeSession=false;
    client.addEventListener('connect',()=>{$('viewer-state').textContent='已连接';$('viewer-box').scrollIntoView({block:'start'});});
    client.addEventListener('disconnect',()=>{if(rfb===client){rfb=undefined;$('viewer-state').textContent='已断开，可重新连接';}});
    client.addEventListener('securityfailure',()=>problem(Error('项目桌面连接失败，请重新连接。')));
    client.addEventListener('clipboard',e=>{$('viewer-clipboard').value=e.detail.text;});
  }
  action($('viewer-connect'),connect);
  action($('viewer-disconnect'),async()=>disconnect());
  action($('viewer-paste'),async()=>{rfb?.clipboardPasteFrom($('viewer-clipboard').value);});
  action($('viewer-fullscreen'),async()=>{const expanded=$('viewer-box').classList.toggle('viewer-expanded');$('viewer-fullscreen').textContent=expanded?'返回面板':'展开画面';});
  $('workspace').addEventListener('change',disconnect);
  $('client-display').addEventListener('change',disconnect);
  return {connect,disconnect,update(status){
    const publicAccess=status.control.remote!=='local';
    if(publicAccess){$('client-display').value='remote';$('client-display').disabled=true;}
    const report=status.runtime.reports.find(r=>r.workspace===workspace());
    $('viewer-connect').disabled=!report?.passed||$('client-display').value!=='remote';
  }};
}
