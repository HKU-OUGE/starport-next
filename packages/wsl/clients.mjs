import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {privateDir,writePrivate,read,run,error} from '../runtime/common.mjs';
import {managedProxy} from '../runtime/managed-proxy.mjs';
import {createEgress,DEFAULT_HOSTS} from '../runtime/egress.mjs';
import {NATIVE_HOSTS,nativeFiles} from '../runtime/native.mjs';
import {guestFiles} from '../runtime/agent.mjs';
import {wslArgs} from './runtime.mjs';

// Temporary installer ingress binds only the owned WSL NAT interface. Project
// namespaces cannot route to it. No firewall or global WSL settings are changed.
export async function installWslClients(state,options,{onProgress=()=>{}}={}){
  if(process.platform!=='win32')throw error('wsl_install_requires_windows');
  state=privateDir(state);const receipt=read(path.join(state,'wsl.json'));
  if(receipt.phase!=='installed')throw error('wsl_install_required');
  const dir=privateDir(path.join(state,'client-install')),lock=path.join(dir,'install.lock');
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}catch{throw error('client_install_requires_reconciliation');}
  let proxy,egress,relay;const sockets=new Set();
  try{
    const route=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/sbin/ip','-j','route','get','1.1.1.1'));
    if(route.code!==0)throw error('wsl_management_route_unavailable');
    const [{gateway,prefsrc}]=JSON.parse(route.stdout);
    if(net.isIP(gateway)!==4||net.isIP(prefsrc)!==4||!Object.values(os.networkInterfaces()).flat().some(v=>v.address===gateway))throw error('owned_wsl_nat_interface_required');
    proxy=await managedProxy(dir,options.proxyCandidates,{binary:options.proxyBinary,onExit:()=>egress?.pause()});
    egress=await createEgress({upstream:proxy.upstream,hosts:[...new Set([...DEFAULT_HOSTS,...NATIVE_HOSTS])]});
    relay=net.createServer(client=>{
      if(client.remoteAddress!==prefsrc){client.destroy();return;}
      const upstream=net.connect(egress.proxyPort,'127.0.0.1');sockets.add(client);sockets.add(upstream);
      for(const s of [client,upstream]){s.on('error',()=>{client.destroy();upstream.destroy();});s.on('close',()=>sockets.delete(s));s.setTimeout(120000,()=>s.destroy());}
      client.pipe(upstream);upstream.pipe(client);
    });
    await new Promise((resolve,reject)=>{relay.once('error',reject);relay.listen(0,gateway,resolve);});
    const installProxy=`http://${gateway}:${relay.address().port}`;
    const connection=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/curl','-fSs','--connect-timeout','8','--max-time','15','--proxy',installProxy,'https://example.com'),{maxBytes:65536});
    if(connection.code!==0)throw error('controlled_installer_proxy_unreachable');
    const architecture=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/uname','-m'));
    const arch=architecture.stdout.trim()==='aarch64'?'arm64':architecture.stdout.trim()==='x86_64'?'x64':null;
    if(!arch)throw error('unsupported_guest_architecture');
    const files=guestFiles(arch);
    const script=fs.readFileSync(new URL('./install-clients.sh',import.meta.url),'utf8').replaceAll('\r\n','\n');
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
    const installed=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/python3','-I','-c',bootstrap),{
      input:JSON.stringify({owner:receipt.owner,proxy:installProxy,files,script}),timeout:1800000,boundedCapture:true,maxBytes:128*1024});
    writePrivate(path.join(dir,'install.log'),installed.stdout+installed.stderr);
    if(installed.code!==0)throw error('wsl_client_install_failed');
    const result={installed:true,checkedAt:new Date().toISOString(),architecture:arch,browser:arch==='x64'?'chrome':'firefox',sdkVersion:'0.3.316',loginVerified:false};
    writePrivate(path.join(state,'clients.json'),result);await configureWslClients(state);writePrivate(path.join(dir,'status.json'),{phase:'installed'});return result;
  }finally{for(const s of sockets)s.destroy();relay?.close();egress?.close();proxy?.close();fs.rmSync(lock,{force:true});}
}

export async function configureWslClients(state){
  const receipt=read(path.join(state,'wsl.json')),clients=read(path.join(state,'clients.json'));
  const standard=nativeFiles(clients.architecture);
  const browser=clients.architecture==='x64'?`#!/bin/bash\nset -eu\nexec /usr/bin/google-chrome-stable --user-data-dir="$HOME/.config/starport-browser" --ozone-platform=wayland --proxy-server=http://127.0.0.1:13128 --proxy-bypass-list="localhost;127.0.0.1;[::1]" --disable-quic --no-first-run --lang=zh-TW "$@"\n`:standard['/usr/local/bin/starport-browser'];
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
