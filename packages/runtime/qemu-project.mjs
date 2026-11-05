import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateDir,read,writePrivate,cleanEnv,error,executable,sleep} from './common.mjs';
import {prepare,guest,sshArgs} from './qemu.mjs';
import {start,control} from './control.mjs';
import {createProjectRuntime} from './project.mjs';
import {runtimeBundle} from './project-bundle.mjs';
import {guestFiles} from './agent.mjs';
import {nativeFiles} from './native.mjs';
import {wslBrowserScript} from '../wsl/clients.mjs';

// This VM's outer network is closed. Each project receives only scoped stdio
// channels from the currently authenticated controller, never its credentials.
export const PROJECT_VM_SETTINGS={upstream:{kind:'http',url:'http://127.0.0.1:9'},hosts:[]};
const runner=fileURLToPath(new URL('./qemu-project-runner.mjs',import.meta.url));
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function projectReceipt(state,{current=true}={}){
  const machine=read(path.join(state,'machine.json')),r=read(path.join(state,'project-runtime.json'));
  if(machine.projectRuntime!==true||r.vmId!==machine.vmId||r.kind!=='qemu'||r.phase!=='installed'||!/^[a-f0-9]{64}$/.test(r.owner||''))throw error('owned_project_vm_required');
  if(current&&r.runtimeDigest!==runtimeBundle().digest)throw error('qemu_runtime_update_requires_idle_migration');
  return r;
}
export function projectGuard(receipt){
  const bundle=runtimeBundle();
  return `import pathlib,hashlib,runpy,os\np=pathlib.Path('/opt/starport-wsl')\nassert os.geteuid()==0 and (p/'owner').read_text()==${JSON.stringify(receipt.owner)}\nd=${JSON.stringify(bundle.digests)}\nfor n,h in d.items():\n f=p/n if n=='runner.py' else p/'public'/n\n st=f.lstat()\n assert not f.is_symlink() and st.st_uid==0 and not(st.st_mode&0o022) and hashlib.sha256(f.read_bytes()).hexdigest()==h\nrunpy.run_path(str(p/'runner.py'),run_name='__main__')`;
}
export function spawnProjectSsh(state,status,receipt){
  return spawn(executable('ssh'),[...sshArgs(state,status.sshPort,'control'),
    'sudo -n /usr/bin/python3 -I -B -c '+quote(projectGuard(receipt))],
    {env:cleanEnv(),shell:false,stdio:['pipe','pipe','pipe']});
}
export async function ensureProjectVm(state){
  projectReceipt(state);
  return start(state,PROJECT_VM_SETTINGS);
}
export async function createQemuRuntime(state,options={}){
  state=privateDir(state);
  let ready=false,installError;
  if(fs.existsSync(path.join(state,'project-runtime.json'))){try{await ensureProjectVm(state);ready=true;}catch(e){installError=e.code||'qemu_project_not_ready';}}
  const digest=()=>{
    let identity={};try{const r=read(path.join(state,'runtime.json'));identity={vmId:r.vmId,runId:r.runId,settingsDigest:r.settingsDigest};}catch{}
    return crypto.createHash('sha256').update(JSON.stringify({bundle:runtimeBundle().digest,...identity})).digest('hex');
  };
  const launch=options.launch||(()=>{
    if(!ready)throw error(installError||'qemu_project_install_required');
    projectReceipt(state);
    return spawn(process.execPath,[runner,state],{env:cleanEnv(),shell:false,stdio:['pipe','pipe','pipe']});
  });
  return createProjectRuntime(state,{...options,launch,kind:'qemu',wslg:false,
    installed:()=>ready,runtimeDigest:digest});
}

// The only administrative SSH commands install verified public runtime sources
// in an owned VM. No model-provided command is accepted at this boundary.
export async function installProjectVm(state,{proxyPort,onProgress=()=>{},clients=true,seamless=false,update=false,repairClients=false,imeOnly=false,inputMethod=true,...resources}={}){
  if(process.platform!=='linux')throw error('linux_control_install_required');
  if(!Number.isInteger(proxyPort)||proxyPort<1||proxyPort>65535)throw error('controlled_install_proxy_required');
  state=privateDir(state);const lock=path.join(state,'project-install.lock');
  try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch{throw error('project_install_requires_reconciliation');}
  let forward;
  try{
    if(!fs.existsSync(path.join(state,'machine.json')))await prepare(state,{...resources,projectRuntime:true,onProgress});
    const machine=read(path.join(state,'machine.json'));
    if(machine.projectRuntime!==true)throw error('separate_project_vm_required');
    const file=path.join(state,'project-runtime.json'),bundle=runtimeBundle();
    let receipt=fs.existsSync(file)?read(file):{kind:'qemu',vmId:machine.vmId,owner:crypto.randomBytes(32).toString('hex'),phase:'prepared'};
    if(receipt.vmId!==machine.vmId||receipt.kind!=='qemu')throw error('owned_project_vm_required');
    if(receipt.phase==='installing')throw error('project_install_requires_reconciliation');
    const addSeamless=receipt.phase==='installed'&&seamless&&!receipt.seamless;
    if(receipt.phase==='installed'&&!update&&!addSeamless&&!repairClients){projectReceipt(state);return {installed:true,reused:true,clients:receipt.clients===true,seamless:receipt.seamless===true};}
    if(update&&receipt.phase!=='installed')throw error('project_install_required');
    const status=await start(state,PROJECT_VM_SETTINGS);
    const log=fs.openSync(path.join(state,'project-install.log'),'a',0o600);
    forward=spawn(executable('ssh'),[...sshArgs(state,status.sshPort,'control',['-N','-o','ExitOnForwardFailure=yes','-R',`127.0.0.1:13129:127.0.0.1:${proxyPort}`])],{env:cleanEnv(),stdio:['ignore',log,log]});
    fs.closeSync(log);forward.on('error',()=>{});await sleep(500);
    if(forward.exitCode!==null)throw error('installer_proxy_tunnel_failed');
    const old={...receipt};receipt.phase='installing';writePrivate(file,receipt);
    let script;
    if(update||addSeamless||repairClients){
      script=`import json,sys,pathlib,fcntl,hashlib,base64,os\nq=json.load(sys.stdin);p=pathlib.Path('/opt/starport-wsl')\nassert (p/'owner').read_text()==q['owner']\nlock=open(p/'runtime.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\nd={}\nfor n in q['oldFiles']:\n f=p/n if n=='runner.py' else p/'public'/n\n assert not f.is_symlink() and f.stat().st_uid==0\n d[n]=hashlib.sha256(f.read_bytes()).hexdigest()\nassert hashlib.sha256(json.dumps(d,separators=(',',':')).encode()).hexdigest()==q['oldDigest']\nexec(compile(q['security'],'project-security','exec'))\nstaged=[]\nfor n,b in q['files'].items():\n assert n in q['allowedFiles']\n f=p/n if n=='runner.py' else p/'public'/n\n data=base64.b64decode(b,validate=True)\n if n.endswith('.py'):compile(data,n,'exec')\n t=f.with_suffix(f.suffix+'.new');t.write_bytes(data);t.chmod(0o644);staged.append((t,f))\nfor t,f in staged:os.replace(t,f)\nprint('updated')`;
    }else script=fs.readFileSync(new URL('../wsl/bootstrap.py',import.meta.url),'utf8');
    onProgress({phase:update?'updating_project_boundary':'installing_project_boundary'});
    const request={runtime:'qemu',proxy:'http://127.0.0.1:13129',owner:receipt.owner,files:bundle.files,
      oldDigest:old.runtimeDigest,oldFiles:old.runtimeFiles,allowedFiles:Object.keys(bundle.files),security:fs.readFileSync(new URL('./qemu-security.py',import.meta.url),'utf8')};
    const installed=await guest(state,status.sshPort,'sudo -n /usr/bin/python3 -I -c '+quote(script),{user:'control',input:JSON.stringify(request),timeout:900000,boundedCapture:true,maxBytes:16384});
    fs.appendFileSync(path.join(state,'project-install.log'),installed.stdout+installed.stderr);
    if(installed.code!==0){writePrivate(file,{...old,phase:update?'installed':'failed'});throw error('project_boundary_install_failed');}
    if(clients&&(!update||addSeamless||repairClients)){
      onProgress({phase:'installing_project_clients'});
      const imeScript=fs.readFileSync(new URL('../wsl/install-ime.sh',import.meta.url),'utf8').replaceAll('\r\n','\n');
      const installScript=imeOnly?imeScript:fs.readFileSync(new URL('../wsl/install-clients.sh',import.meta.url),'utf8').replaceAll('\r\n','\n')+(inputMethod?'\n'+imeScript:'');
      const standard=nativeFiles(machine.host.arch);
      const files={
        '/usr/local/bin/starport-browser':wslBrowserScript(machine.host.arch),
        '/usr/share/applications/starport-browser.desktop':standard['/usr/share/applications/starport-browser.desktop'],
        '/opt/starport-wsl/etc/opt/chrome/policies/managed/starport.json':standard['/etc/opt/chrome/policies/managed/starport.json'],
        '/opt/starport-wsl/etc/firefox/policies/policies.json':standard['/etc/firefox/policies/policies.json'],
        '/opt/starport-wsl/etc/machine-id':'00000000000000000000000000000001\n',
        '/opt/starport-wsl/etc/dbus-1/session.conf':'<busconfig/>\n',
      };
      const bootstrap=`import pathlib,json,sys,subprocess,fcntl\nq=json.load(sys.stdin);p=pathlib.Path('/opt/starport-wsl')\nassert (p/'owner').read_text()==q['owner']\nlock=open(p/'runtime.lock','a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)\ntarget=pathlib.Path('/usr/local/lib/starport/agent');target.mkdir(parents=True,exist_ok=True)\nfor n,b in q['agent'].items():\n assert n in ('package.json','package-lock.json','agent.mjs','files.py')\n (target/n).write_text(b)\nenv={'PATH':'/usr/local/bin:/usr/bin:/bin','STARPORT_INSTALL_PROXY':'http://127.0.0.1:13129'}\nsubprocess.run(['/bin/bash','--noprofile','--norc','-s'],input=q['script'],text=True,env=env,check=True)\nfor name,body in q['configuration'].items():\n f=pathlib.Path(name);assert not f.is_symlink();f.parent.mkdir(parents=True,exist_ok=True);f.write_text(body);f.chmod(0o755 if name.startswith('/usr/local/bin/') else 0o644)\n`;
      const extra=seamless&&!imeOnly?'\napt-get "${apt_options[@]}" install -y --no-install-recommends xpra xvfb xauth python3-pil\n':'';
      const r=await guest(state,status.sshPort,'sudo -n /usr/bin/python3 -I -c '+quote(bootstrap),{user:'control',input:JSON.stringify({owner:receipt.owner,agent:guestFiles(machine.host.arch),configuration:files,script:installScript+extra}),timeout:1800000,boundedCapture:true,maxBytes:32768});
      fs.appendFileSync(path.join(state,'project-install.log'),r.stdout+r.stderr);
      if(r.code!==0){
        // The runtime bundle has already been replaced. Keep its actual digest
        // so an interrupted IME-only package repair can safely be retried.
        writePrivate(file,imeOnly?{...receipt,phase:'installed',runtimeDigest:bundle.digest,runtimeFiles:Object.keys(bundle.files),clients:old.clients===true,seamless:old.seamless===true}:{...receipt,phase:'failed'});
        throw error('project_clients_install_failed');
      }
    }
    receipt={...receipt,phase:'installed',runtimeDigest:bundle.digest,runtimeFiles:Object.keys(bundle.files),clients:(update||imeOnly)?old.clients:clients,seamless:addSeamless?true:(update||imeOnly)?old.seamless:seamless,verified:false};
    writePrivate(file,receipt);return {installed:true,clients:receipt.clients,seamless:receipt.seamless,verified:false};
  }finally{forward?.kill();fs.rmSync(lock,{force:true});}
}
