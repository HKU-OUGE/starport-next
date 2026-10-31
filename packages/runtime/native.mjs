import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {control} from './control.mjs';
import {guest,sshArgs} from './qemu.mjs';
import {read,writePrivate,error,cleanEnv,executable,sleep} from './common.mjs';
import {verificationMatches} from './agent.mjs';

// Installation and official authentication only. Each request still traverses the
// exact-host CONNECT guard and the owned proxy, including browser authentication.
export const NATIVE_HOSTS=['claude.ai','claude.com','platform.claude.com','sso.claude.com','downloads.claude.ai','code.claude.com',
  'anthropic.com','a-api.anthropic.com','a-cdn.anthropic.com','s-cdn.anthropic.com','assets-proxy.anthropic.com',
  'a.claude.ai','assets.claude.ai','bridge.claudeusercontent.com','challenges.cloudflare.com','fonts.googleapis.com','fonts.gstatic.com',
  'archive.ubuntu.com','security.ubuntu.com','ports.ubuntu.com','dl.google.com','packages.mozilla.org'];
const directory=fileURLToPath(new URL('./guest/',import.meta.url));
export const nativeEnvironment={HOME:'/home/agent',USER:'agent',LOGNAME:'agent',PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'en_US.UTF-8',
  LC_TIME:'en_US.UTF-8',TZ:'Asia/Taipei',DISPLAY:':1',XAUTHORITY:'/home/agent/.Xauthority',XDG_RUNTIME_DIR:'/run/starport-native',
  HTTP_PROXY:'http://127.0.0.1:13128',HTTPS_PROXY:'http://127.0.0.1:13128',ALL_PROXY:'http://127.0.0.1:13128',NO_PROXY:'127.0.0.1,localhost',
  CLAUDE_CONFIG_DIR:'/home/agent/.claude-account',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',ENABLE_CLAUDEAI_MCP_SERVERS:'false',
  BROWSER:'/usr/local/bin/starport-browser'};
export function nativeFiles(arch='x64'){
  if(!['x64','arm64'].includes(arch))throw error('unsupported_guest_architecture');
  const env=Object.entries(nativeEnvironment).map(([k,v])=>`${k}=${v}`).join('\n')+'\n';
  return {
    '/etc/starport/native.env':env,
    '/usr/local/bin/starport-browser':arch==='arm64'?`#!/bin/bash\nset -eu\nmkdir -p "$HOME/.config/starport-browser"\nexec /usr/bin/firefox --profile "$HOME/.config/starport-browser" "$@"\n`:`#!/bin/bash\nset -eu\nexec /usr/bin/google-chrome-stable --user-data-dir="$HOME/.config/starport-browser" --proxy-server=http://127.0.0.1:13128 --proxy-bypass-list="localhost;127.0.0.1;[::1]" --disable-quic --no-first-run --lang=en-US "$@"\n`,
    '/usr/local/bin/starport-account-login':`#!/bin/bash\nset -eu\ncd /workspace/account-smoke\nunset ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN ANTHROPIC_BASE_URL CLAUDE_CODE_OAUTH_TOKEN\nclaude auth login --claudeai\nprintf '\\nAccount login completed. This window can be closed.\\n'\nread -r -p 'Press Enter to close.' ignored\n`,
    '/usr/local/bin/starport-native-session':`#!/bin/bash\nset -eu\numask 077\nmkdir -p "$HOME/.config" "$HOME/.local/share/applications" "$HOME/.claude-account" /workspace/account-smoke /workspace/downloads\nxauth -f "$XAUTHORITY" add :1 . "$(mcookie)"\n/usr/bin/Xtigervnc :1 -geometry 1600x1000 -depth 24 -localhost -rfbport 5901 -SecurityTypes VncAuth -PasswordFile "$HOME/.config/starport-vnc" -auth "$XAUTHORITY" -SendCutText=1 -AcceptCutText=1 -SetPrimary=0 -SendPrimary=0 -MaxCutText=1048576 &\nvnc_pid=$!\ntrap 'kill "$vnc_pid" 2>/dev/null || true' EXIT\nfor n in $(seq 1 50); do test -S /tmp/.X11-unix/X1 && break; sleep 0.1; done\nwebsockify --web=/usr/share/novnc 127.0.0.1:6080 127.0.0.1:5901 &\nxdg-settings set default-web-browser starport-browser.desktop || true\nxdg-mime default starport-browser.desktop x-scheme-handler/https x-scheme-handler/http\nexec dbus-run-session -- /usr/bin/openbox-session\n`,
    '/usr/share/applications/starport-browser.desktop':'[Desktop Entry]\nType=Application\nName=Workspace Browser\nExec=/usr/local/bin/starport-browser %U\nMimeType=x-scheme-handler/http;x-scheme-handler/https;text/html;\nTerminal=false\n',
    '/etc/systemd/system/starport-native.service':`[Unit]\nDescription=Starport native client workspace display\nAfter=network.target\n[Service]\nUser=agent\nGroup=agent\nSlice=user-1001.slice\nEnvironmentFile=/etc/starport/native.env\nRuntimeDirectory=starport-native\nRuntimeDirectoryMode=0700\nExecStart=/usr/local/bin/starport-native-session\nKillMode=control-group\nRestart=no\n`,
    '/etc/firefox/policies/policies.json':JSON.stringify({policies:{Proxy:{Mode:'manual',Locked:true,HTTPProxy:'127.0.0.1:13128',UseHTTPProxyForAllProtocols:true,Passthrough:'localhost,127.0.0.1,[::1]'},DNSOverHTTPS:{Enabled:false,Locked:true},DisableTelemetry:true,DisableFirefoxStudies:true,DisableAccounts:true,OfferToSaveLogins:false,DownloadDirectory:'/workspace/downloads',Preferences:{'media.peerconnection.enabled':{Value:false,Status:'locked'},'network.http.http3.enable':{Value:false,Status:'locked'},'network.dns.disablePrefetch':{Value:true,Status:'locked'},'network.prefetch-next':{Value:false,Status:'locked'},'browser.search.suggest.enabled':{Value:false,Status:'locked'}}}})+'\n',
    '/etc/opt/chrome/policies/managed/starport.json':JSON.stringify({ProxyMode:'fixed_servers',ProxyServer:'http://127.0.0.1:13128',ProxyBypassList:'localhost;127.0.0.1;[::1]',DnsOverHttpsMode:'off',QuicAllowed:false,WebRtcIPHandling:'disable_non_proxied_udp',BrowserSignin:0,SyncDisabled:true,BackgroundModeEnabled:false,PasswordManagerEnabled:false,DownloadDirectory:'/workspace/downloads'})+'\n'
  };
}
export async function installNative(state,{onData}={}){
  const current=await control(state),machine=read(path.join(state,'machine.json'));
  if(!current.ready)throw error('workspace_not_ready');
  if(machine.memoryMiB<4096)throw error('native_client_requires_4096_mib');
  if(!['x64','arm64'].includes(machine.host.arch))throw error('unsupported_guest_architecture');
  const lock=path.join(state,'native-install.lock');
  try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')throw error('native_install_in_progress');throw e;}
  try{
    const install=await guest(state,current.sshPort,'sudo env -i PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc -s 2>&1',
      {user:'control',input:fs.readFileSync(path.join(directory,'install-native.sh'),'utf8'),timeout:1500000,maxBytes:65536,boundedCapture:true,onData});
    if(install.code!==0){writePrivate(path.join(state,'native-install-error.log'),install.stdout+install.stderr);throw error('native_package_install_failed');}
    return await configureNative(state);
  }finally{fs.rmSync(lock,{force:true});}
}
export async function configureNative(state){
  const current=await control(state);if(!current.ready)throw error('workspace_not_ready');
  const arch=read(path.join(state,'machine.json')).host.arch;
  const browser=arch==='arm64'?'firefox':'google-chrome-stable';
  const packageCheck=await guest(state,current.sshPort,`test -x /usr/bin/claude && test -x /usr/bin/claude-desktop && /usr/bin/claude --version && /usr/bin/${browser} --version`,{timeout:15000});
  if(packageCheck.code!==0)throw error('native_package_check_failed');
  const secretFile=path.join(state,'native-viewer-secret');
  const password=fs.existsSync(secretFile)?fs.readFileSync(secretFile,'utf8').trim():crypto.randomBytes(6).toString('base64url');
  if(!fs.existsSync(secretFile))writePrivate(secretFile,password+'\n');
  const userSetup=String.raw`import os,pathlib,subprocess,sys
os.umask(0o077)
d=pathlib.Path('/home/agent/.config')
if d.is_symlink(): raise RuntimeError('config_symlink')
d.mkdir(exist_ok=True)
f=d/'starport-vnc'
b=subprocess.check_output(['tigervncpasswd','-f'],input=sys.stdin.buffer.read())
fd=os.open(f,os.O_WRONLY|os.O_CREAT|os.O_TRUNC|os.O_NOFOLLOW,0o600)
with os.fdopen(fd,'wb') as out: out.write(b)
`;
  const code=`import json,sys,pathlib,subprocess\np=json.load(sys.stdin)\nfor name,body in p['files'].items():\n f=pathlib.Path(name);f.parent.mkdir(parents=True,exist_ok=True);f.write_text(body);f.chmod(0o755 if name.startswith('/usr/local/bin/') else 0o644)\nsubprocess.run(['sudo','-u','agent','python3','-c',${JSON.stringify(userSetup)}],input=(p['password']+'\\n').encode(),check=True)\nsubprocess.run(['systemctl','daemon-reload'],check=True)\nprint('configured')\n`;
  const command="sudo python3 -c '"+code.replaceAll("'","'\\''")+"'";
  const r=await guest(state,current.sshPort,command,{user:'control',input:JSON.stringify({files:nativeFiles(arch),password}),timeout:30000});
  if(r.code!==0)throw error('native_configuration_failed');
  const receipt={installed:true,architecture:arch,browser,vmId:current.vmId,checkedAt:new Date().toISOString(),browserInsideGuest:true,clipboard:"manual-text",noAutomaticHostClipboard:true,hostDirectories:false};
  writePrivate(path.join(state,'native-installed.json'),receipt);return receipt;
}
export async function nativeStatus(state){
  const current=await control(state);
  if(!current.ready)return {ready:false};
  const r=await guest(state,current.sshPort,'env -i HOME=/home/agent PATH=/usr/bin:/bin CLAUDE_CONFIG_DIR=/home/agent/.claude-account /usr/bin/claude auth status --json',{timeout:15000});
  let status;try{status=JSON.parse(r.stdout);}catch{status={loggedIn:false};}
  // Account identity and organization fields never leave the native workspace.
  return {workspaceReady:true,loggedIn:status.loggedIn===true,authMethod:status.authMethod||null,apiKeyGateway:current.modelReady===true};
}
export async function nativeUi(state){
  const current=await control(state),v=read(path.join(state,'verification.json'));
  if(!current.ready||!verificationMatches(v,current))throw error('current_isolation_verification_required');
  if(current.modelReady)throw error('native_account_mode_requires_api_gateway_off');
  const installed=read(path.join(state,'native-installed.json'));
  if(installed.vmId!==current.vmId)throw error('native_clients_not_installed');
  const r=await guest(state,current.sshPort,'sudo systemctl start starport-native.service && sudo systemctl is-active starport-native.service',{user:'control',timeout:20000});
  if(r.code!==0)throw error('native_display_start_failed');
  const receipt=path.join(state,'native-viewer.json');let prior;try{prior=read(receipt);}catch{}
  const url=port=>`http://127.0.0.1:${port}/vnc.html#autoconnect=1&resize=scale&password=${encodeURIComponent(fs.readFileSync(path.join(state,'native-viewer-secret'),'utf8').trim())}`;
  if(prior?.runId===current.runId){try{const check=await fetch(`http://127.0.0.1:${prior.port}/vnc.html`,{signal:AbortSignal.timeout(2000)});if(check.ok)return {url:url(prior.port),reused:true};}catch{}}
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  const log=fs.openSync(path.join(state,'native-viewer.log'),'a',0o600);
  const child=spawn(executable('ssh'),sshArgs(state,current.sshPort,'control',['-N','-o','ExitOnForwardFailure=yes','-L',`127.0.0.1:${port}:127.0.0.1:6080`]),{env:cleanEnv(),detached:true,windowsHide:true,stdio:['ignore',log,log]});
  fs.closeSync(log);child.on('error',()=>{});child.unref();
  writePrivate(receipt,{pid:child.pid,port,runId:current.runId});
  for(let i=0;i<40;i++){await sleep(250);try{const check=await fetch(`http://127.0.0.1:${port}/vnc.html`,{signal:AbortSignal.timeout(1000)});if(check.ok)return {url:url(port),clipboard:"manual-text",noAutomaticHostClipboard:true,hostBrowserOnlyDisplaysPixels:true};}catch{}}
  throw error('native_viewer_unavailable');
}
export async function launchNative(state,client){
  if(!['login','desktop','terminal','browser'].includes(client))throw error('native_client_invalid');
  const current=await control(state),v=read(path.join(state,'verification.json'));
  if(!current.ready||current.modelReady||!verificationMatches(v,current))throw error('verified_account_workspace_required');
  if(client==='login'&&(await nativeStatus(state)).loggedIn)return {launched:'login',alreadyAuthenticated:true};
  const check=await guest(state,current.sshPort,'systemctl is-active --quiet starport-native.service',{user:'control',timeout:10000});
  if(check.code!==0)throw error('native_display_required');
  const active=await guest(state,current.sshPort,`systemctl is-active --quiet starport-native-${client}.service`,{user:'control',timeout:10000});
  if(active.code===0)return {launched:client,reused:true,browserInsideGuest:true};
  const commands={login:'/usr/bin/xterm -title "Claude Code account login" -e /usr/local/bin/starport-account-login',desktop:'/usr/bin/dbus-run-session -- /usr/bin/claude-desktop --proxy-server=http://127.0.0.1:13128 --disable-quic',terminal:'/usr/bin/xterm -title "Workspace terminal"',browser:'/usr/local/bin/starport-browser https://claude.ai'};
  const cmd=`sudo systemd-run --unit=starport-native-${client} --collect --property=User=agent --property=Group=agent --property=Slice=user-1001.slice --property=EnvironmentFile=/etc/starport/native.env --property=WorkingDirectory=/workspace/account-smoke ${commands[client]}`;
  const r=await guest(state,current.sshPort,cmd,{user:'control',timeout:20000});
  if(r.code!==0)throw error('native_client_launch_failed');return {launched:client,browserInsideGuest:true};
}
