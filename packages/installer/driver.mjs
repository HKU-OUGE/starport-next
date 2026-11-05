import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {error,run,read,privateDir,sleep,writePrivate,executable} from '../runtime/common.mjs';
import {loadControlOptions} from '../control/config.mjs';
import {installLinuxProject} from '../linux/install.mjs';
import {installWslClients} from '../wsl/clients.mjs';
import {updateWslRuntime,wslArgs} from '../wsl/runtime.mjs';
import {createLinuxServices} from '../control/linux-services.mjs';
import {control as vmControl} from '../runtime/control.mjs';
import {vendorBinary} from './download.mjs';
const here=fileURLToPath(new URL('.',import.meta.url));
export function paths(root){return {app:path.join(root,'app'),node:path.join(root,'runtime',process.platform==='win32'?'node.exe':'bin/node'),state:path.join(root,'private/control'),config:path.join(root,'private/host-control.json'),wsl:path.join(root,'private/wsl'),qemu:path.join(root,'private/qemu')};}
export async function panelClient(root){
  const p=paths(root),file=path.join(p.state,'control.json');if(!fs.existsSync(file))return null;
  const r=read(file);if(r.phase==='stopped')return null;
  if(!Number.isInteger(r.port)||r.port<1024||r.port>65535)throw error('invalid_control_receipt');
  const origin='http://127.0.0.1:'+r.port,key=read(path.join(p.state,'panel-key.json')).key;let cookie='',csrf='';
  async function request(route,body){const res=await fetch(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',headers:{origin,cookie,'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});if(route==='/api/login')cookie=res.headers.get('set-cookie')?.split(';')[0]||'';const v=await res.json();if(!res.ok)throw error(/^[a-z_]+$/.test(v.error)?v.error:'control_request_failed');return v;}
  try{await request('/api/login',{key});const status=await request('/api/status');csrf=status.csrf;return {status,request,origin};}
  catch{let alive=false;if(Number.isInteger(r.pid))try{process.kill(r.pid,0);alive=true;}catch{}if(alive)throw error('control_unreachable_cannot_confirm_idle');return null;}
}
export async function ensureIdle(root){const client=await panelClient(root);if(client&&(client.status.runtime.active.length||client.status.jobs.some(j=>!['completed','failed','cancelled','succeeded','archived'].includes(j.status))))throw error('active_work_close_before_update');return client;}
async function command(root,file,args,{timeout=600000}={}){const log=path.join(privateDir(path.join(root,'private/setup')),'install.log');const r=await run(file,args,{timeout,boundedCapture:true,maxBytes:128*1024,env:{...process.env,PATH:path.dirname(paths(root).node)+path.delimiter+(process.env.PATH||'')}});fs.appendFileSync(log,r.stdout+r.stderr,{mode:0o600});if(r.code!==0)throw error(r.code===3010?'system_restart_required':r.code===1223||r.code===126||r.code===127?'administrator_authorization_cancelled':'install_step_failed');return r;}
export async function prerequisites(root,p){
  if(process.platform==='win32'){
    const wsl=p.features.workspace?await run('wsl.exe',['--status']).catch(()=>({code:1})):{code:0},ssh=!p.features.compute||!!executable('ssh');
    if(wsl.code||!ssh)await command(root,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'elevate.ps1'),...(wsl.code?['-NeedWsl']:[]),...(!ssh?['-NeedSsh']:[])]);
    if(p.features.workspace&&(await run('wsl.exe',['--status']).catch(()=>({code:1}))).code)throw error('system_restart_required');return;
  }
  const names=p.features.workspace?['qemu-system-x86_64','qemu-img','ssh','bwrap','sshfs','zenity']:p.features.compute?['ssh']:[];if(p.features.seamless)names.push('xpra','Xvfb','xauth');
  let elevated=false;
  if(names.some(n=>!executable(n))){
    if(!executable('pkexec'))throw error('system_authorization_helper_missing');
    await command(root,'pkexec',['/bin/sh',path.join(here,'prerequisites.sh'),os.userInfo().username,p.features.workspace?'1':'0',p.features.seamless?'1':'0']);elevated=true;
  }
  if(p.features.workspace){try{fs.accessSync('/dev/kvm',fs.constants.R_OK|fs.constants.W_OK);}catch{
    if(elevated)throw error('login_required_for_kvm');
    if(!executable('pkexec'))throw error('system_authorization_helper_missing');
    await command(root,'pkexec',['/bin/sh',path.join(here,'prerequisites.sh'),os.userInfo().username,'1',p.features.seamless?'1':'0']);
    try{fs.accessSync('/dev/kvm',fs.constants.R_OK|fs.constants.W_OK);}catch{throw error('login_required_for_kvm');}
  }}
}
export async function stopOwned(root,{removeStartup=true}={}){
  const p=paths(root),client=await ensureIdle(root),record=fs.existsSync(path.join(p.state,'control.json'))?read(path.join(p.state,'control.json')):null;
  if(client)await client.request('/api/installer/quiesce',{});
  try{
  if(process.platform==='linux'&&fs.existsSync(path.join(p.state,'linux-services.json'))){const s=createLinuxServices(p.state,p.config,{repo:p.app,node:p.node});if(removeStartup)await s.action('disable');await s.action('stop');if(removeStartup)await s.action('unregister');}
  if(process.platform==='win32'&&fs.existsSync(path.join(p.state,'services-manifest.json'))){await command(root,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(p.app,'scripts/register-startup.ps1'),'-Action','disable','-State',p.state,'-Config',p.config]);await command(root,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'stop-supervisor.ps1'),'-State',p.state,'-Repo',p.app]);}
  if(client){try{await client.request('/api/installer/stop',{});}catch{if(await panelClient(root))throw error('control_stop_unconfirmed');}}
  for(let i=0;i<120;i++){let alive=false;if(Number.isInteger(record?.pid)&&record.pid>0)try{process.kill(record.pid,0);alive=true;}catch{}if(!alive&&!(await panelClient(root)))return;await sleep(250);}throw error('control_stop_unconfirmed');
  }catch(e){if(client)try{await client.request('/api/installer/resume',{});}catch{}throw e;}
}
export async function startControl(root){
  const p=paths(root),old=await panelClient(root);if(old)return old;
  privateDir(p.state);const lock=path.join(p.state,'control.lock');if(fs.existsSync(lock)){const r=read(lock);let alive=false;try{process.kill(r.pid,0);alive=true;}catch{}if(alive)throw error('control_lock_requires_reconciliation');fs.rmSync(lock);}
  const fd=fs.openSync(path.join(p.state,'install-start.log'),'a',0o600);const child=spawn(p.node,[path.join(p.app,'bin/starport.mjs'),'control','serve','--state',p.state,'--config',p.config],{shell:false,cwd:p.app,env:process.env,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});fs.closeSync(fd);child.unref();let failed=false;child.on('error',()=>failed=true);
  for(let i=0;i<240;i++){if(failed||child.exitCode!==null)throw error('control_start_failed');try{const c=await panelClient(root);if(c)return c;}catch{}await sleep(500);}throw error('control_start_timeout');
}
export async function runStage(stage,{root,plan:p,progress}){
  const loc=paths(root),opts=()=>loadControlOptions(loc.config);
  if(stage==='prerequisites')return prerequisites(root,p);
  if(stage==='proxy')return vendorBinary('mihomo',path.join(root,'private/bin'),{progress});
  if(stage==='workspace'){
    if(process.platform==='linux')return installLinuxProject(opts(),{clients:p.features.clients,inputMethod:p.features.inputMethod,repairClients:fs.existsSync(path.join(loc.qemu,'project-runtime.json')),cpus:p.cpus,memoryMiB:p.memoryMiB,diskGiB:p.diskGiB,onProgress:progress});
    if(fs.existsSync(path.join(loc.wsl,'wsl.json')))return updateWslRuntime(loc.wsl);
    return command(root,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(loc.app,'scripts/setup-wsl.ps1'),'-State',loc.wsl],{timeout:3600000});
  }
  if(stage==='clients'&&process.platform==='win32')return installWslClients(loc.wsl,opts(),{inputMethod:p.features.inputMethod,onProgress:progress});
  if(stage==='tunnel')return vendorBinary('cloudflared',path.join(root,'private/bin'),{progress});
  if(stage==='shortcuts')return command(root,process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'integration.ps1'),'-Root',root,'-Action','register']: [path.join(here,'integration.sh'),root,'register']);
  if(stage==='control')return startControl(root);
  if(stage==='verification'){
    const client=await panelClient(root);if(!client)throw error('control_not_ready');const r=await client.request('/api/workspaces/main/verify',{});if(!r.passed)throw error('workspace_boundary_verification_failed');return r;
  }
  if(stage==='startup'){
    if(process.platform==='linux'){const s=createLinuxServices(loc.state,loc.config,{repo:loc.app,node:loc.node});await s.action('enable');return;}
    return command(root,'powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(loc.app,'scripts/register-startup.ps1'),'-Action','enable','-State',loc.state,'-Config',loc.config,'-Node',loc.node]);
  }
}
export async function uninstallRuntime(root,{deleteData=false}={}){
  const p=paths(root);await stopOwned(root);
  if(process.platform==='linux'&&fs.existsSync(path.join(p.qemu,'runtime.json'))){await vmControl(p.qemu,'/stop','POST');for(let i=0;i<120;i++){if((await vmControl(p.qemu)).phase==='stopped')break;if(i===119)throw error('vm_stop_unconfirmed');await sleep(500);}}
  if(process.platform==='win32'&&fs.existsSync(path.join(p.wsl,'wsl.json'))){const r=read(path.join(p.wsl,'wsl.json'));wslArgs(r.distribution);const owner=await run('wsl.exe',wslArgs(r.distribution,'/usr/bin/cat','/opt/starport-wsl/owner'));if(owner.code!==0||owner.stdout.trim()!==r.owner)throw error('wsl_ownership_unconfirmed');await command(root,'wsl.exe',[deleteData?'--unregister':'--terminate',r.distribution]);}
  return command(root,process.platform==='win32'?'powershell.exe':'/bin/sh',process.platform==='win32'?['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(here,'integration.ps1'),'-Root',root,'-Action','remove']:[path.join(here,'integration.sh'),root,'remove']);
}
