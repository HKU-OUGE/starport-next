import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { privateDir,writePrivate,read,hash,cleanEnv,run,error } from '../runtime/common.mjs';
import { pipeBridge } from '../control/pipe-bridge.mjs';

const source = fileURLToPath(new URL('.', import.meta.url));
function runtimeBundle(){
  const files={};for(const name of ['runner.py','guest-entry.py'])files[name]=fs.readFileSync(path.join(source,name)).toString('base64');
  files['files.py']=fs.readFileSync(new URL('../runtime/guest/files.py',import.meta.url)).toString('base64');
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
  r.phase='installed';r.verified=false;r.runtimeDigest=bundle.digest;writePrivate(receipt,r);
  return {distribution:r.distribution,installed:true,verified:false,locale:'zh_TW.UTF-8',timezone:'Asia/Taipei'};
}

export function createWslRuntime(state, { launch, destinations, capabilities, onState=()=>{} } = {}) {
  const active=new Map();const reports=new Map();let alive=true;
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
    const key=workspace+':'+request.operation;
    if(active.has(key))throw error('workspace_busy');
    const token=capabilities(workspace),child=spawnRunner();
    let stdout='',stderr='',settled=false,bridge;
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const done=new Promise((resolve,reject)=>{
      const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);active.delete(key);bridge?.close();onState();err?reject(err):resolve(result);};
      const timer=setTimeout(()=>{bridge?.close();child.kill();finish(error('workspace_operation_timeout'));},timeout);
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
      child.stdin.write(JSON.stringify({workspace,request:{...request,...token}})+'\n');
    });
    onState();return done;
  }
  return {execute,reports,
    status:()=>({kind:'wsl2',installed:fs.existsSync(path.join(state,'wsl.json')),active:[...active].map(([key,v])=>({workspace:key.split(':')[0],operation:key.split(':')[1],startedAt:v.startedAt})),reports:[...reports].map(([workspace,receipt])=>({workspace,...receipt}))}),
    close(){alive=false;for(const {bridge} of active.values())bridge.close();}
  };
}
