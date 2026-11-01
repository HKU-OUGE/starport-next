import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { privateDir,writePrivate,read,hash,cleanEnv,run,error } from '../runtime/common.mjs';
import { pipeBridge } from '../control/pipe-bridge.mjs';

const source = fileURLToPath(new URL('.', import.meta.url));
const bundleNames=['runner.py','guest-entry.py','native-session.py','sdk-agent.mjs','client-status.py','compute-mcp.py','configure-compute.py','COMPUTE-AGENT.md','files.py','compute-client.py'];
export function runtimeBundle(){
  const files={};for(const name of bundleNames.filter(n=>!['files.py','compute-client.py'].includes(n)))files[name]=fs.readFileSync(path.join(source,name)).toString('base64');
  files['files.py']=fs.readFileSync(new URL('../runtime/guest/files.py',import.meta.url)).toString('base64');
  files['compute-client.py']=fs.readFileSync(new URL('../../scripts/compute-client.py',import.meta.url)).toString('base64');
  const digests=Object.fromEntries(Object.entries(files).map(([n,b])=>[n,crypto.createHash('sha256').update(Buffer.from(b,'base64')).digest('hex')]));
  return {files,digests,digest:crypto.createHash('sha256').update(JSON.stringify(digests)).digest('hex')};
}
export function wslArgs(distribution, ...command) {
  if (!/^StarportWork-[a-f0-9]{16}$/.test(distribution || '')) throw error('owned_wsl_distribution_required');
  return ['--distribution', distribution, '--user', 'root', '--exec', ...command];
}
export function decodeNames(buffer) {
  return Buffer.from(buffer).toString(Buffer.from(buffer).includes(0) ? 'utf16le' : 'utf8').replaceAll('\0','').replace(/^\uFEFF/,'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
}
export async function installWsl(state, { rootfs, sha256, onProgress = () => {} } = {}) {
  if (process.platform !== 'win32') throw error('wsl_install_requires_windows');
  state = privateDir(state);
  const bundle=runtimeBundle();
  if (!/^[a-f0-9]{64}$/.test(sha256 || '') || await hash(rootfs) !== sha256) throw error('rootfs_hash_mismatch');
  const receipt = path.join(state, 'wsl.json');
  let r = fs.existsSync(receipt) ? read(receipt) : { distribution: 'StarportWork-' + crypto.randomBytes(8).toString('hex'), owner: crypto.randomBytes(24).toString('hex'), phase: 'prepared' };
  wslArgs(r.distribution);
  const listing = await run('wsl.exe', ['--list','--quiet']);
  if (listing.code !== 0) throw error('wsl2_setup_required');
  // run() decodes stdout as UTF-8; strip NULs from WSL's ASCII-only registered name list.
  const names = listing.stdout.replaceAll('\0','');
  if (names.split(/\r?\n/).map(x=>x.trim()).includes(r.distribution)) {
    const owner = await run('wsl.exe', wslArgs(r.distribution, '/usr/bin/cat', '/opt/starport-wsl/owner'));
    if (owner.code !== 0 || owner.stdout.trim() !== r.owner) throw error('wsl_import_requires_reconciliation');
    if (r.phase === 'installed') {
      if(r.runtimeDigest!==bundle.digest)throw error('wsl_runtime_update_requires_idle_migration');
      return { distribution: r.distribution, installed: true, reused: true };
    }
  } else {
    if (!['prepared','importing'].includes(r.phase)) throw error('owned_distribution_missing');
    r.phase='importing';writePrivate(receipt,r);onProgress({phase:'importing_owned_distribution'});
    const imported=await run('wsl.exe',['--import',r.distribution,path.join(state,'disk'),path.resolve(rootfs),'--version','2'],{timeout:600000});
    if(imported.code!==0)throw error('wsl_import_failed_reconcile_before_retry');
    r.phase='imported';writePrivate(receipt,r);
  }
  onProgress({phase:'installing_workspace_boundary'});
  const files=bundle.files;
  const script=fs.readFileSync(path.join(source,'bootstrap.py'),'utf8');
  const installed=await run('wsl.exe',wslArgs(r.distribution,'/usr/bin/python3','-I','-c',script),{
    input:JSON.stringify({owner:r.owner,files}),timeout:900000,boundedCapture:true,maxBytes:8192});
  if(installed.code!==0)throw error('wsl_bootstrap_failed');
  // Only the newly owned distribution is restarted; never wsl --shutdown.
  const stopped=await run('wsl.exe',['--terminate',r.distribution]);if(stopped.code!==0)throw error('owned_wsl_restart_failed');
  r.phase='installed';r.verified=false;r.runtimeDigest=bundle.digest;r.runtimeFiles=Object.keys(bundle.files);writePrivate(receipt,r);
  return {distribution:r.distribution,installed:true,verified:false,locale:'zh_TW.UTF-8',timezone:'Asia/Taipei'};
}

// Explicit idle migration; verify ownership and installed source before writes.
export async function updateWslRuntime(state){
  state=privateDir(state);const file=path.join(state,'wsl.json'),receipt=read(file),bundle=runtimeBundle();
  if(receipt.phase!=='installed')throw error('wsl_install_required');
  const oldFiles=receipt.runtimeFiles||['runner.py','guest-entry.py','files.py'];
  const updateFile=path.join(state,'runtime-update.json');
  if(fs.existsSync(updateFile)&&read(updateFile).phase==='applying')throw error('runtime_update_requires_reconciliation');
  writePrivate(updateFile,{phase:'applying',from:receipt.runtimeDigest,to:bundle.digest,startedAt:new Date().toISOString()});
  const script=`import json,sys,pathlib,hashlib,base64,fcntl,os
q=json.load(sys.stdin);root=pathlib.Path('/opt/starport-wsl')
assert (root/'owner').read_text()==q['owner']
lease=open(root/'runtime.lock','a')
try:fcntl.flock(lease,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:sys.exit(75)
locks=[];base=pathlib.Path('/var/lib/starport-workspaces')
for workspace in base.iterdir() if base.exists() else []:
 assert not workspace.is_symlink()
 for name in ['run.lock','files.lock','native.lock']:
  lock=open(workspace/name,'a')
  try:fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
  except BlockingIOError:sys.exit(75)
  locks.append(lock)
digests={}
for name in q['oldFiles']:
 assert name in ${JSON.stringify(bundleNames)}
 p=root/name if name=='runner.py' else root/'public'/name
 assert not p.is_symlink() and p.stat().st_uid==0 and p.stat().st_mode&0o022==0
 digests[name]=hashlib.sha256(p.read_bytes()).hexdigest()
assert hashlib.sha256(json.dumps(digests,separators=(',',':')).encode()).hexdigest()==q['oldDigest']
staged=[]
for name,value in q['files'].items():
 assert name in ${JSON.stringify(bundleNames)}
 p=root/name if name=='runner.py' else root/'public'/name
 assert not p.is_symlink()
 data=base64.b64decode(value,validate=True)
 if name.endswith('.py'):compile(data,name,'exec')
 temporary=p.with_name(p.name+'.update')
 with open(temporary,'xb') as out:out.write(data);out.flush();os.fsync(out.fileno())
 temporary.chmod(0o644);staged.append((temporary,p))
for temporary,p in staged:os.replace(temporary,p)
print(json.dumps({'updated':True}))
`;
  const result=await run('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/python3','-I','-c',script),{
    input:JSON.stringify({owner:receipt.owner,oldDigest:receipt.runtimeDigest,oldFiles,files:bundle.files}),timeout:60000});
  if(result.code===75){writePrivate(updateFile,{phase:'busy',from:receipt.runtimeDigest,to:bundle.digest});throw error('workspace_operations_active');}
  if(result.code!==0){writePrivate(path.join(state,'runtime-update-error.log'),result.stderr);throw error('runtime_update_failed_reconcile_before_retry');}
  writePrivate(file,{...receipt,runtimeDigest:bundle.digest,runtimeFiles:Object.keys(bundle.files),verified:false});
  writePrivate(updateFile,{phase:'complete',from:receipt.runtimeDigest,to:bundle.digest,completedAt:new Date().toISOString()});
  return {updated:true,verified:false};
}

export function createWslRuntime(state, { launch, destinations, capabilities, wslg=false, onState=()=>{} } = {}) {
  const active=new Map(),nativeStates=new Map();const reports=new Map();let alive=true;
  const spawnRunner=launch||(()=>{
    if(process.platform!=='win32')throw error('wsl_runtime_requires_windows');
    const r=read(path.join(state,'wsl.json'));if(r.phase!=='installed')throw error('wsl_install_required');
    const bundle=runtimeBundle();if(r.runtimeDigest!==bundle.digest)throw error('wsl_runtime_update_requires_idle_migration');
    const guard=`import hashlib,pathlib,runpy\np=pathlib.Path('/opt/starport-wsl')\nassert (p/'owner').read_text()==${JSON.stringify(r.owner)}\nd=${JSON.stringify(bundle.digests)}\nfor n,h in d.items():\n f=p/n if n=='runner.py' else p/'public'/n\n assert not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==h\nrunpy.run_path(str(p/'runner.py'),run_name='__main__')`;
    return spawn('wsl.exe',wslArgs(r.distribution,'/usr/bin/python3','-I','-B','-c',guard),{
      shell:false,windowsHide:true,env:cleanEnv({WSLENV:''}),stdio:['pipe','pipe','pipe']});
  });
  function execute(workspace,request,{timeout=120000,onOutput=()=>{}}={}) {
    if(!alive||!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw error('invalid_workspace');
    if(request.operation==='native'&&!wslg)throw error('wslg_authorization_required');
    const key=workspace+':'+request.operation;
    if(active.has(key))throw error('workspace_busy');
    if(['exec','sdk'].includes(request.operation)&&['exec','sdk'].some(op=>active.has(workspace+':'+op)))throw error('workspace_busy');
    const token={...capabilities(workspace)},child=spawnRunner();
    if(request.operation==='native')delete token.modelCapability;
    let stdout='',stderr='',settled=false,bridge;
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const done=new Promise((resolve,reject)=>{
      const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);active.delete(key);bridge?.close();onState();err?reject(err):resolve(result);};
      const timer=timeout===null?null:setTimeout(()=>{bridge?.close();child.kill();finish(error('workspace_operation_timeout'));},timeout);
      bridge=pipeBridge(child,destinations,{onEvent:f=>{
        if(f.type==='output'){
          if(typeof f.data!=='string'||f.data.length>32768)return finish(error('invalid_runner_output'));
          if(!decoders[f.stream])return finish(error('invalid_runner_stream'));
          const text=decoders[f.stream].write(Buffer.from(f.data,'base64'));
          if(f.stream==='stdout')stdout=(stdout+text).slice(-96*1024*1024);else stderr=(stderr+text).slice(-1024*1024);
          onOutput({stream:f.stream,text});
        }else if(f.type==='exit')finish(null,{code:f.code,stdout,stderr});
        else if(f.type==='failure')finish(error('workspace_runner_failed'));
        else if(f.type==='disconnected')finish(error('workspace_control_disconnected'));
      }});
      active.set(key,{child,bridge,startedAt:new Date().toISOString()});
      child.stdin.write(JSON.stringify({workspace,request:{...request,...token,...(request.operation==='native'?{wslg:true}:{})}})+'\n');
    });
    onState();return done;
  }
  async function nativeAction(workspace,app){
    if(!wslg)throw error('wslg_authorization_required');
    if(!['browser','desktop','terminal','login'].includes(app))throw error('invalid_native_app');
    const id=workspace+':native';
    if(!active.has(id)){
      let readyResolve,readyReject,pending='';
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      nativeStates.set(workspace,{phase:'starting',apps:{}});
      const timer=setTimeout(()=>{active.get(id)?.bridge.close();readyReject(error('native_start_timeout'));},20000);
      const done=execute(workspace,{operation:'native'},{timeout:null,onOutput:({stream,text})=>{
        if(stream!=='stdout')return;
        pending+=text;if(pending.length>65536){active.get(id)?.bridge.close();return;}
        let index;while((index=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,index);pending=pending.slice(index+1);
          try{const value=JSON.parse(line);
            if(value.kind==='native_ready'){nativeStates.set(workspace,{phase:'running',apps:{}});clearTimeout(timer);readyResolve();}
            if(value.kind==='native_state'){const apps=Object.fromEntries(Object.entries(value.apps||{}).filter(([k,v])=>['browser','desktop','terminal','login'].includes(k)&&['running','stopped'].includes(v)));nativeStates.set(workspace,{phase:'running',apps});}
          }catch{}
        }
      }});
      done.then(result=>{clearTimeout(timer);nativeStates.set(workspace,{phase:result.code===0?'stopped':'failed',apps:{}});readyReject(error('native_session_stopped'));},()=>{clearTimeout(timer);nativeStates.set(workspace,{phase:'stopped',apps:{}});readyReject(error('native_session_stopped'));});
      await ready;
    }
    const session=active.get(id);if(!session)throw error('native_session_unavailable');
    session.bridge.send({type:'native-action',app});return {requested:app,...nativeStates.get(workspace)};
  }
  const digest=()=>runtimeBundle().digest;
  return {execute,reports,nativeAction,digest,
    async stopNative(workspace){
      const session=active.get(workspace+':native');if(!session)return;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(error('native_stop_requires_reconciliation')),12000);
        session.child.once('close',()=>{clearTimeout(timer);resolve();});
        session.bridge.close();
      });
    },
    status:()=>({kind:'wsl2',installed:fs.existsSync(path.join(state,'wsl.json'))&&read(path.join(state,'wsl.json')).phase==='installed',wslg,clipboard:wslg?'shared-with-windows':'not-shared',native:[...nativeStates].map(([workspace,value])=>({workspace,...value})),active:[...active].map(([key,v])=>({workspace:key.split(':')[0],operation:key.split(':')[1],startedAt:v.startedAt})),reports:[...reports].map(([workspace,receipt])=>({workspace,...receipt,passed:receipt.passed&&receipt.runtimeDigest===digest()&&Date.now()-Date.parse(receipt.checkedAt)<=86400000}))}),
    close(){alive=false;for(const {bridge} of active.values())bridge.close();}
  };
}
