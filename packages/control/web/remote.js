const $=id=>document.getElementById(id);
export function initRemoteSettings({api,problem,action}){
  let loaded,dirty=false;
  function controls(){
    const enabled=$('remote-enabled').checked;$('remote-fields').disabled=!enabled;
    for(const id of ['remote-hostname','remote-emails','remote-issuer','remote-audience'])$(id).required=enabled;
    $('remote-token-label').hidden=!$('remote-tunnel').checked;
  }
  function show(value){
    loaded=value;dirty=false;$('remote-save').disabled=!value.supported;
    $('remote-enabled').checked=value.enabled===true;
    for(const [id,key] of [['remote-hostname','hostname'],['remote-issuer','issuer'],['remote-audience','audience']])$(id).value=value[key]||'';
    $('remote-emails').value=(value.allowedEmails||[]).join('\n');$('remote-tunnel').checked=value.tunnelEnabled===true;$('remote-token').value='';
    $('remote-token').placeholder=value.tokenPresent?'已保存；留空保持':'输入此 Tunnel 的 Token';
    const phase=value.active?.tunnel?.phase;
    $('remote-status').textContent=value.active?.enabled?(phase==='process-running'?'连接器运行中':phase==='failed'||phase==='exited'?'连接器需检查':'已配置 Access'):'仅本机';
    $('remote-check').disabled=!value.active?.enabled;
    $('remote-link').hidden=!value.active?.hostname;
    if(value.active?.hostname)$('remote-link').href='https://'+value.active.hostname+'/';
    controls();
  }
  async function load(){show(await api('/api/remote-access'));}
  $('remote-form').addEventListener('input',()=>{dirty=true;});
  $('remote-enabled').addEventListener('change',controls);$('remote-tunnel').addEventListener('change',controls);
  document.addEventListener('starport:view',e=>{if(e.detail==='remote'&&!dirty)load().catch(problem);});
  $('remote-form').addEventListener('submit',async e=>{
    e.preventDefault();$('remote-save').disabled=true;$('remote-result').textContent='';
    try{
      if(!loaded)await load();
      const value=await api('/api/remote-access',{revision:loaded.revision,enabled:$('remote-enabled').checked,hostname:$('remote-hostname').value,
        allowedEmails:$('remote-emails').value.split(/[\s,;，；]+/).filter(Boolean),issuer:$('remote-issuer').value,audience:$('remote-audience').value,
        tunnelEnabled:$('remote-tunnel').checked,tunnelToken:$('remote-token').value});
      show(value);$('remote-result').textContent=value.enabled?'本机配置已应用，公网登录待验证。':'远程访问已关闭，本机面板继续运行。';
    }catch(e){$('remote-result').textContent=e.message;problem(e);}
    finally{$('remote-token').value='';$('remote-save').disabled=false;}
  });
  action($('remote-check'),async()=>{const value=await api('/api/remote-access/check',{});$('remote-result').textContent=value.originRejectsUnauthenticated?'源站已拒绝无凭据请求，公网登录仍需验证。':'源站检查未通过。';});
  action($('remote-reload'),load);
}
