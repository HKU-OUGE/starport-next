import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {privateDir,read,writePrivate,error,run,executable,cleanEnv} from '../runtime/common.mjs';
import {control} from '../runtime/control.mjs';
import {guest} from '../runtime/qemu.mjs';
import {runtimeBundle} from '../runtime/project-bundle.mjs';
import {projectReceipt} from '../runtime/qemu-project.mjs';

const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
export function folderUser(workspace){
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw error('invalid_workspace');
  return 'sf'+crypto.createHash('sha256').update(workspace).digest('hex').slice(0,12);
}
export function mountArguments(state,port,user,destination){
  if(!/^sf[a-f0-9]{12}$/.test(user)||!Number.isInteger(port)||port<1||port>65535)throw error('invalid_project_sftp');
  return [user+'@127.0.0.1:/project',destination,'-p',String(port),
    '-o','ssh_command=ssh -F /dev/null -oForwardAgent=no','-o','IdentityFile='+JSON.stringify(path.join(state,'identity')),
    '-o','UserKnownHostsFile='+JSON.stringify(path.join(state,'known_hosts')),'-o','HostKeyAlias=starship',
    '-o','GlobalKnownHostsFile=/dev/null','-o','StrictHostKeyChecking=yes','-o','BatchMode=yes',
    '-o','IdentitiesOnly=yes','-o','IdentityAgent=none',
    '-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',
    '-o','reconnect','-o','idmap=user','-o','nodev,nosuid,noexec','-o','follow_symlinks'];
}
export function mountedFilesystem(destination,text=fs.readFileSync('/proc/self/mountinfo','utf8')){
  const unescape=s=>s.replace(/\\([0-7]{3})/g,(_,v)=>String.fromCharCode(parseInt(v,8)));
  for(const line of text.trim().split('\n')){
    const [left,right]=line.split(' - ');if(!right)continue;
    if(unescape(left.split(' ')[4])===destination)return right.split(' ')[0];
  }return null;
}
export async function openLinuxFolder(controlState,qemuState,workspace,{open=true,execute=run,launch=spawn}={}){
  if(process.platform!=='linux')throw error('linux_folder_action_required');
  if(!executable('sshfs'))throw error('sshfs_not_installed');
  const user=folderUser(workspace),receipt=projectReceipt(qemuState),status=await control(qemuState);
  if(!status.ready||status.vmId!==receipt.vmId)throw error('workspace_not_ready');
  const base=privateDir(path.join(controlState,'project-folders')),destination=path.join(base,workspace);
  const record=path.join(base,workspace+'.json');let old;try{old=read(record);}catch{}
  const mounted=mountedFilesystem(destination);
  if(mounted){
    if(mounted!=='fuse.sshfs'||old?.vmId!==receipt.vmId||old?.workspace!==workspace||old?.path!==destination)throw error('project_mount_ownership_unknown');
    if(old.runId!==status.runId){const r=await execute('fusermount3',['-u',destination]);if(r.code!==0)throw error('project_mount_busy');}
  }
  if(!mountedFilesystem(destination)){
    const publicKey=fs.readFileSync(path.join(qemuState,'identity.pub'),'utf8').trim();
    if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: [^\n]*)?$/.test(publicKey))throw error('invalid_project_key');
    const script=`import pathlib,json,sys,pwd,subprocess,re,importlib.util,fcntl,hashlib
q=json.load(sys.stdin);p=pathlib.Path('/opt/starport-wsl')
assert (p/'owner').read_text()==q['owner'] and re.fullmatch(r'[a-z][a-z0-9-]{0,47}',q['workspace']) and re.fullmatch(r'sf[a-f0-9]{12}',q['user'])
lease=open(p/'runtime.lock','a');fcntl.flock(lease,fcntl.LOCK_SH)
for n,h in q['hashes'].items():
 f=p/n if n=='runner.py' else p/'public'/n;st=f.lstat()
 assert not f.is_symlink() and st.st_uid==0 and not(st.st_mode&0o022) and hashlib.sha256(f.read_bytes()).hexdigest()==h
s=importlib.util.spec_from_file_location('runner',p/'runner.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
root=m.prepare_workspace(pathlib.Path('/var/lib/starport-workspaces'),q['workspace'])
assert root.stat().st_uid==0 and root.stat().st_mode&0o022==0
try:
 account=pwd.getpwnam(q['user']);assert account.pw_uid==1000 and account.pw_shell=='/usr/sbin/nologin'
except KeyError:subprocess.run(['useradd','-o','-u','1000','-g','1000','-M','-d','/project','-s','/usr/sbin/nologin',q['user']],check=True)
keys=pathlib.Path('/etc/starport-files');keys.mkdir(mode=0o755,exist_ok=True)
guard=open(keys/'lock','a');fcntl.flock(guard,fcntl.LOCK_EX)
(keys/(q['user']+'.pub')).write_text(q['key']+'\\n');(keys/(q['user']+'.pub')).chmod(0o644)
record=keys/(q['user']+'.json');value={'user':q['user'],'root':str(root)}
if record.exists():assert json.loads(record.read_text())==value
record.write_text(json.dumps(value));record.chmod(0o600)
records=[json.loads(f.read_text()) for f in keys.glob('sf*.json')]
text='AllowUsers '+' '.join(r['user'] for r in records)+'\\n'
for r in records:text+='Match User '+r['user']+'\\n    ChrootDirectory '+r['root']+'\\n    AuthorizedKeysFile /etc/starport-files/'+r['user']+'.pub\\n    ForceCommand internal-sftp -d /project\\n    AllowTcpForwarding no\\n    AllowAgentForwarding no\\n    PermitTTY no\\n    X11Forwarding no\\n    PermitTunnel no\\n'
text+='Match all\\n';conf=pathlib.Path('/etc/ssh/sshd_config.d/20-starport-files.conf');conf.write_text(text);conf.chmod(0o600)
subprocess.run(['/usr/sbin/sshd','-t'],check=True);subprocess.run(['systemctl','reload','ssh'],check=True)
print('project_sftp_ready')`;
    const result=await guest(qemuState,status.sshPort,'sudo -n /usr/bin/python3 -I -c '+quote(script),{user:'control',input:JSON.stringify({owner:receipt.owner,workspace,user,key:publicKey,hashes:runtimeBundle().digests}),timeout:30000});
    if(result.code!==0)throw error('project_sftp_setup_failed');
    privateDir(destination);
    if(fs.readdirSync(destination).length)throw error('mount_directory_not_empty');
    const mounted=await execute('sshfs',mountArguments(qemuState,status.sshPort,user,destination),{timeout:20000,env:cleanEnv()});
    if(mounted.code!==0||mountedFilesystem(destination)!=='fuse.sshfs')throw error('project_mount_failed');
    writePrivate(record,{workspace,user,path:destination,vmId:receipt.vmId,runId:status.runId});
  }
  if(open){
    const child=launch('gio',['open',destination],{shell:false,stdio:'ignore',detached:true});
    await new Promise((resolve,reject)=>{child.once('error',()=>reject(error('file_manager_unavailable')));child.once('spawn',resolve);});child.unref();
  }
  return {opened:open,mounted:true,folder:destination};
}
