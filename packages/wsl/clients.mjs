import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {privateDir,writePrivate,read,run,error} from '../runtime/common.mjs';
import {managedProxy} from '../runtime/managed-proxy.mjs';
import {createEgress,DEFAULT_HOSTS} from '../runtime/egress.mjs';
import {NATIVE_HOSTS,nativeFiles} from '../runtime/native.mjs';
import {guestFiles} from '../runtime/agent.mjs';
import {wslArgs} from './runtime.mjs';
import {runInstaller} from './installer-pipe.mjs';

// Downloads use the controlled proxy over stdio, with no Windows inbound port.
export async function installWslClients(state,options,{onProgress=()=>{},remoteOnly=false,imeOnly=false,inputMethod=true}={}){
  if(process.platform!=='win32')throw error('wsl_install_requires_windows');
  state=privateDir(state);const receipt=read(path.join(state,'wsl.json'));
  if(receipt.phase!=='installed')throw error('wsl_install_required');
  const dir=privateDir(path.join(state,'client-install')),lock=path.join(dir,'install.lock');
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}catch{throw error('client_install_requires_reconciliation');}
  let proxy,egress;
  try{
    proxy=await managedProxy(dir,options.proxyCandidates,{binary:options.proxyBinary,onExit:()=>egress?.pause()});
    egress=await createEgress({upstream:proxy.upstream,hosts:[...new Set([...DEFAULT_HOSTS,...NATIVE_HOSTS])]});
    const architecture=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/uname','-m'));
    const arch=architecture.stdout.trim()==='aarch64'?'arm64':architecture.stdout.trim()==='x86_64'?'x64':null;
    if(!arch)throw error('unsupported_guest_architecture');
    const files=guestFiles(arch);
    const fullScript=fs.readFileSync(new URL('./install-clients.sh',import.meta.url),'utf8').replaceAll('\r\n','\n');
    const imeScript=fs.readFileSync(new URL('./install-ime.sh',import.meta.url),'utf8').replaceAll('\r\n','\n');
    const script=imeOnly?imeScript:remoteOnly?fullScript.split('install -d -m 0755 /etc/apt/keyrings')[0]:fullScript+(inputMethod?'\n'+imeScript:'');
    const bootstrap=`import json,sys,pathlib,subprocess,fcntl,os
q=json.load(sys.stdin)
assert os.geteuid()==0 and pathlib.Path('/opt/starport-wsl/owner').read_text()==q['owner']
lease=open('/opt/starport-wsl/runtime.lock','a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
locks=[]
base=pathlib.Path('/var/lib/starport-workspaces')
for workspace in base.iterdir() if base.exists() else []:
 for name in ['run.lock','files.lock','native.lock']:
  lock=open(workspace/name,'a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(lock)
target=pathlib.Path('/usr/local/lib/starport/agent');target.mkdir(parents=True,exist_ok=True)
for name,content in q['files'].items():
 assert name in ['package.json','package-lock.json','agent.mjs','files.py']
 f=target/name
 assert not f.is_symlink()
 f.write_text(content);f.chmod(0o644)
env={'PATH':'/usr/local/bin:/usr/bin:/bin','STARPORT_INSTALL_PROXY':q['proxy']}
result=subprocess.run(['/bin/bash','--noprofile','--norc','-s'],input=q['script'],text=True,env=env)
sys.exit(result.returncode)
`;
    onProgress({phase:'installing_wsl_clients'});
    writePrivate(path.join(dir,'status.json'),{phase:'installing',startedAt:new Date().toISOString()});
    const installed=await runInstaller(receipt,bootstrap,{owner:receipt.owner,files,script},egress.proxyPort);
    writePrivate(path.join(dir,'install.log'),installed.stdout+installed.stderr);
    if(installed.code!==0)throw error('wsl_client_install_failed');
    if(imeOnly){const result={inputMethodInstalled:true,checkedAt:new Date().toISOString()};writePrivate(path.join(dir,'status.json'),{phase:'installed',...result});return result;}
    if(remoteOnly){await configureWslClients(state);const result={remoteDisplayInstalled:true,checkedAt:new Date().toISOString()};writePrivate(path.join(dir,'status.json'),{phase:'installed',...result});return result;}
    const result={installed:true,checkedAt:new Date().toISOString(),architecture:arch,browser:arch==='x64'?'chrome':'firefox',sdkVersion:'0.3.316',loginVerified:false};
    writePrivate(path.join(state,'clients.json'),result);await configureWslClients(state);writePrivate(path.join(dir,'status.json'),{phase:'installed'});return result;
  }finally{egress?.close();proxy?.close();fs.rmSync(lock,{force:true});}
}

export function wslBrowserScript(architecture){
  return architecture==='x64'?`#!/bin/bash\nset -eu\nextra=()\nif [ "\${STARPORT_PASSWORD_STORE:-keyring}" = basic ]; then extra+=(--password-store=basic); fi\nexec /usr/bin/google-chrome-stable --user-data-dir="$HOME/.config/starport-browser" --ozone-platform="\${ELECTRON_OZONE_PLATFORM_HINT:-wayland}" --proxy-server=http://127.0.0.1:13128 --proxy-bypass-list="localhost;127.0.0.1;[::1]" --disable-quic --no-first-run --lang=zh-TW "\${extra[@]}" "$@"\n`:nativeFiles(architecture)['/usr/local/bin/starport-browser'];
}
export async function configureWslClients(state){
  if(process.platform!=='win32')throw error('wsl_install_requires_windows');
  const receipt=read(path.join(state,'wsl.json')),clients=read(path.join(state,'clients.json'));
  if(receipt.phase!=='installed')throw error('wsl_install_required');
  const standard=nativeFiles(clients.architecture);
  const browser=wslBrowserScript(clients.architecture);
  const files={
    '/usr/local/bin/starport-browser':browser,
    '/usr/share/applications/starport-browser.desktop':standard['/usr/share/applications/starport-browser.desktop'],
    '/opt/starport-wsl/etc/opt/chrome/policies/managed/starport.json':standard['/etc/opt/chrome/policies/managed/starport.json'],
    '/opt/starport-wsl/etc/firefox/policies/policies.json':standard['/etc/firefox/policies/policies.json'],
    '/opt/starport-wsl/etc/machine-id':'00000000000000000000000000000001\n',
  };
  const script=`import sys,json,pathlib,fcntl
q=json.load(sys.stdin)
assert pathlib.Path('/opt/starport-wsl/owner').read_text()==q['owner']
lease=open('/opt/starport-wsl/runtime.lock','a');fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
for name,body in q['files'].items():
 f=pathlib.Path(name);assert not f.is_symlink();f.parent.mkdir(parents=True,exist_ok=True);f.write_text(body);f.chmod(0o755 if name.startswith('/usr/local/bin/') else 0o644)
p=pathlib.Path('/opt/starport-wsl/etc/dbus-1');p.mkdir(exist_ok=True)
(p/'session.conf').write_text('<busconfig/>\\n')
print('configured')
`;
  const r=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/python3','-I','-c',script),{input:JSON.stringify({owner:receipt.owner,files})});
  if(r.code!==0)throw error('wsl_client_configuration_failed');
  return {configured:true};
}
