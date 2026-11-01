// The remote page may navigate to the local panel, but never launches a host
// application or carries authentication into that link.
export function workspaceAccess(status,workspace){
  const windows=status?.control.platform==='win32',local=status?.control.remote==='local';
  const valid=/^[a-z][a-z0-9-]{0,47}$/.test(workspace||'')&&status?.workspaces.includes(workspace);
  const port=status?.control.port;
  return {
    label:local?'本机 WSL2':'安装电脑 · WSL2',
    canOpen:windows&&local&&valid,
    localUrl:windows&&!local&&valid&&Number.isInteger(port)&&port>=1024&&port<=65535
      ?`http://127.0.0.1:${port}/?workspace=${encodeURIComponent(workspace)}#workspaces`:null
  };
}
export function showWorkspaceAccess(status,workspace,button,link){
  const access=workspaceAccess(status,workspace);
  button.hidden=!access.canOpen;
  button.disabled=!status?.runtime.reports.some(r=>r.workspace===workspace&&r.passed);
  link.hidden=!access.localUrl;
  if(access.localUrl)link.href=access.localUrl;else link.removeAttribute('href');
  return access;
}
