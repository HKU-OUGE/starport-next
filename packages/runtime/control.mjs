import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { error,read,writePrivate,cleanEnv,sleep,privateDir } from './common.mjs';
import { guest } from './qemu.mjs';

const daemon=fileURLToPath(new URL('./daemon.mjs',import.meta.url));
export async function control(state,route='/status',method='GET') {
  const r=read(path.join(state,'runtime.json'));
  let result;
  try{result=await fetch(`http://127.0.0.1:${r.controlPort}${route}`,{method,headers:{Authorization:`Bearer ${r.token}`},signal:AbortSignal.timeout(3000),redirect:'error'});}
  catch{
    // The supervisor records stopped only after QEMU has exited, then closes its
    // HTTP socket. A normal stopped workspace must remain queryable and stoppable.
    if(r.phase==='stopped'&&r.ready===false){
      if(route==='/status')return {running:false,ready:false,phase:'stopped',egress:'closed',modelReady:false,vmId:r.vmId,runId:r.runId,settingsDigest:r.settingsDigest,lastError:r.lastError||null,stopConfirmed:true};
      if(route==='/stop'&&method==='POST')return {stopping:false,stopped:true};
    }
    throw error('runtime_control_unavailable');
  }
  if(!result.ok)throw error('runtime_control_unavailable');
  const data=await result.json();if(route==='/status'&&data.vmId!==read(path.join(state,'machine.json')).vmId)throw error('runtime_identity_mismatch');
  return data;
}
export async function start(state,settings) {
  state=privateDir(state);
  let current;try{current=await control(state);}catch{}
  if(current?.running){
    if(current.settingsDigest!==crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex'))throw error('configuration_changed_stop_workspace_first');
    return {...current,reused:true};
  }
  if(!current&&fs.existsSync(path.join(state,'runtime.json'))){
    const old=read(path.join(state,'runtime.json'));let alive=false;
    if(Number.isInteger(old.pid))try{process.kill(old.pid,0);alive=true;}catch{}
    if(old.phase!=='stopped'&&alive)throw error('runtime_status_unknown_do_not_duplicate');
  }
  const lock=path.join(state,'start.lock');
  if(fs.existsSync(lock))throw error('runtime_start_in_progress');
  fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  try{
    const log=fs.openSync(path.join(state,'supervisor.log'),'a',0o600);
    const child=spawn(process.execPath,[daemon,state],{env:cleanEnv(),detached:true,shell:false,windowsHide:true,stdio:['pipe',log,log]});
    fs.closeSync(log);let launchError=false;child.on('error',()=>{launchError=true;});child.stdin.on('error',()=>{});
    child.stdin.end(JSON.stringify(settings));child.unref();
    for(let i=0;i<180;i++){
      if(launchError)throw error('runtime_launch_failed');
      try{const current=await control(state);if(current.ready)return current;if(current.lastError)throw error(current.lastError);}catch(e){if(e.code&&/^(guest_|runtime_|qemu_|egress_|virtual_)/.test(e.code))throw e;}
      await sleep(1000);
    }throw error('runtime_start_timeout');
  }finally{fs.rmSync(lock,{force:true});}
}
export async function execute(state,code,{timeout=60000,onData}={}) {
  const status=await control(state);if(!status.ready)throw error('workspace_not_ready');
  const command="env -i HOME=/home/agent USER=agent LOGNAME=agent PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TZ=Asia/Taipei HTTP_PROXY=http://127.0.0.1:13128 HTTPS_PROXY=http://127.0.0.1:13128 ALL_PROXY=http://127.0.0.1:13128 NO_PROXY=127.0.0.1,localhost /bin/bash --noprofile --norc -s";
  return guest(state,status.sshPort,command,{input:'cd /workspace\n'+code,timeout,onData});
}
export async function verify(state) {
  const first=await control(state);if(!first.ready)throw error('workspace_not_ready');
  const probe=String.raw`python3 - <<'PY'
import os,json,socket,urllib.request,pathlib,subprocess,struct
def tcp(host,port):
 try:
  with socket.create_connection((host,port),timeout=1.5): return True
 except OSError:return False
def fetch():
 try:
  with urllib.request.build_opener(urllib.request.ProxyHandler({'https':'http://127.0.0.1:13128'})).open('https://example.com',timeout=25) as r:return r.status==200
 except Exception:return False
def dns(host):
 try:
  s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(1.5)
  query=struct.pack('!6H',19001,256,1,0,0,0)+b'\x07example\x03com\x00'+struct.pack('!2H',1,1)
  s.sendto(query,(host,53));s.recv(4096);s.close();return True
 except OSError:return False
print(json.dumps({'hostname':socket.gethostname(),'user':os.getenv('USER'),'timezone':os.getenv('TZ'),'ssh_env_absent':not any(k.startswith('SSH_') for k in os.environ),'host_home_absent':set(p.name for p in pathlib.Path('/home').iterdir())<=set(['control','agent','ubuntu']),'no_admin':subprocess.run(['sudo','-n','true'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0,'no_shared_mount':not any(x in pathlib.Path('/proc/mounts').read_text() for x in ('virtiofs','9p','cifs')),'direct_public_tcp_denied':not tcp('1.1.1.1',443),'host_gateway_denied':not tcp('10.0.2.2',22),'metadata_denied':not tcp('169.254.169.254',80),'direct_dns_denied':not dns('1.1.1.1'),'host_dns_denied':not dns('10.0.2.3'),'ipv6_denied':not tcp('2606:4700:4700::1111',443),'controlled_https':fetch()}))
PY`;
  const normal=await execute(state,probe,{timeout:45000});if(normal.code!==0)throw error('isolation_probe_failed');
  const checks=JSON.parse(normal.stdout.trim());
  let closed;
  await control(state,'/egress/pause','POST');
  try{
    const result=await execute(state,probe,{timeout:45000});if(result.code!==0)throw error('closed_egress_probe_failed');closed=JSON.parse(result.stdout.trim());
  }finally{await control(state,'/egress/resume','POST');}
  const pass=checks.hostname==='starship'&&checks.user==='agent'&&checks.timezone==='Asia/Taipei'&&
    ['ssh_env_absent','host_home_absent','no_admin','no_shared_mount','direct_public_tcp_denied','host_gateway_denied','metadata_denied','direct_dns_denied','host_dns_denied','ipv6_denied','controlled_https'].every(k=>checks[k])&&
    closed.controlled_https===false&&closed.direct_public_tcp_denied===true;
  const evidence={format:1,passed:pass,checkedAt:new Date().toISOString(),platform:process.platform,architecture:process.arch,
    vmId:first.vmId,runId:first.runId,settingsDigest:first.settingsDigest,checks,proxyStopped:{requestDenied:!closed.controlled_https,directStillDenied:closed.direct_public_tcp_denied},scope:'local-vm-acceptance'};
  writePrivate(path.join(state,'verification.json'),evidence);return evidence;
}
