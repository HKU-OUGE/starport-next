import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import { fileURLToPath } from 'node:url';
import { privateDir,writePrivate,read,hash,cleanEnv,run,error } from '../runtime/common.mjs';
import {createProjectRuntime} from '../runtime/project.mjs';
import {runtimeBundle,bundleNames} from '../runtime/project-bundle.mjs';
export {runtimeBundle} from '../runtime/project-bundle.mjs';
const source = fileURLToPath(new URL('.', import.meta.url));

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

export function createWslRuntime(state,options={}) {
  const spawnRunner=options.launch||(()=>{
    if(process.platform!=='win32')throw error('wsl_runtime_requires_windows');
    const r=read(path.join(state,'wsl.json'));if(r.phase!=='installed')throw error('wsl_install_required');
    const bundle=runtimeBundle();if(r.runtimeDigest!==bundle.digest)throw error('wsl_runtime_update_requires_idle_migration');
    const guard=`import hashlib,pathlib,runpy\np=pathlib.Path('/opt/starport-wsl')\nassert (p/'owner').read_text()==${JSON.stringify(r.owner)}\nd=${JSON.stringify(bundle.digests)}\nfor n,h in d.items():\n f=p/n if n=='runner.py' else p/'public'/n\n assert not f.is_symlink() and hashlib.sha256(f.read_bytes()).hexdigest()==h\nrunpy.run_path(str(p/'runner.py'),run_name='__main__')`;
    return spawn('wsl.exe',wslArgs(r.distribution,'/usr/bin/python3','-I','-B','-c',guard),{
      shell:false,windowsHide:true,env:cleanEnv({WSLENV:''}),stdio:['pipe','pipe','pipe']});
  });
  return createProjectRuntime(state,{...options,launch:spawnRunner,kind:'wsl2',
    installed:()=>fs.existsSync(path.join(state,'wsl.json'))&&read(path.join(state,'wsl.json')).phase==='installed'});
}
