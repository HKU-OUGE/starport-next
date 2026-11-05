import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {privateDir,read,writePrivate,error,run,cleanEnv} from '../runtime/common.mjs';
import {relative} from '../config/model.mjs';

const repository=fileURLToPath(new URL('../../',import.meta.url));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export function unitArgument(value,{command=true}={}){
  if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw error('invalid_service_path');
  const escaped=value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%');
  return '"'+(command?escaped.replaceAll('$',()=> '$$'):escaped)+'"';
}
export function linuxServicePlan(state,configurationFile,{repo=repository,node=process.execPath}={}){
  state=path.resolve(state);configurationFile=path.resolve(configurationFile);
  const config=read(configurationFile),base=path.dirname(configurationFile);
  if(config.format!=='starport-host-control'||config.version!==1)throw error('invalid_control_configuration');
  const id=hash(state+'\0'+configurationFile).slice(0,16),prefix='starport-next-'+id;
  const resolve=(value,root=base)=>{if(!relative(value))throw error('relative_service_path_required');return path.resolve(root,value);};
  const entries=[];
  if(config.workspaceEnabled!==false&&(config.runtime?.kind||'qemu')==='qemu')entries.push({id:'vm',state:resolve(config.runtime?.state||'qemu'),configurationFile,kind:'vm'});
  const workers=[...(config.workerComputeFile?[{id:'primary',workerComputeFile:config.workerComputeFile}]:[]),...(config.computeNodes||[]).filter(n=>n.workerComputeFile)];
  for(const w of workers){
    if(!/^[a-z][a-z0-9-]{0,47}$/.test(w.id))throw error('invalid_compute_node');
    const file=resolve(w.workerComputeFile),worker=read(file);
    entries.push({id:'compute-'+w.id,state:resolve(worker.state,path.dirname(file)),configurationFile:file,kind:'compute'});
  }
  entries.push({id:'control',state,configurationFile,kind:'control'});
  if(new Set(entries.map(x=>x.state)).size!==entries.length)throw error('duplicate_service_state');
  for(const entry of entries)entry.name=prefix+'-'+entry.id+'.service';
  const units=entries.map(entry=>{
    const dependencies=entry.kind==='control'?entries.filter(x=>x.kind!=='control').map(x=>x.name):[];
    const argv=[node,path.join(repo,'scripts/service-entry.mjs'),'--kind',entry.kind,'--state',entry.state,'--config',entry.configurationFile];
    const text=['[Unit]','Description=Starport Next '+entry.id,'StartLimitIntervalSec=0',
      ...(dependencies.length?['Wants='+dependencies.join(' '),'After='+dependencies.join(' ')]:[]),
      '[Service]','Type=simple','ExecStart='+argv.map(v=>unitArgument(v)).join(' '),
      'WorkingDirectory='+repo.replaceAll('\\','\\\\').replaceAll('%','%%'),'Restart=on-failure','RestartSec=5','TimeoutStopSec=65','KillMode=mixed','UMask=0077',
      '[Install]','WantedBy=default.target',''].join('\n');
    return {...entry,text,sha256:hash(text)};
  });
  return {format:'starport-linux-user-services',version:1,id,state,configurationFile,repo,node,units};
}
export function createLinuxServices(state,configurationFile,{home=os.homedir(),execute=run,repo=repository,node=process.execPath,unitDirectory}={}){
  const directory=unitDirectory||path.join(home,'.config/systemd/user'),manifestFile=path.join(state,'linux-services.json');
  const env=cleanEnv(Object.fromEntries(['XDG_RUNTIME_DIR','DBUS_SESSION_BUS_ADDRESS'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])));
  const call=async args=>{const r=await execute('systemctl',['--user',...args],{env,timeout:20000,maxBytes:65536});if(r.code!==0)throw error('user_service_operation_failed');return r;};
  function owned(){
    if(!fs.existsSync(manifestFile))return null;
    const m=read(manifestFile);
    if(!/^[a-f0-9]{16}$/.test(m.id)||!Array.isArray(m.units)||!m.units.length||m.units.length>34||m.format!=='starport-linux-user-services'||m.state!==path.resolve(state)||m.configurationFile!==path.resolve(configurationFile)||m.repo!==repo)throw error('service_ownership_mismatch');
    for(const unit of m.units){
      if(!new RegExp('^starport-next-'+m.id+'-(control|vm|compute-[a-z][a-z0-9-]{0,47})\\.service$').test(unit.name))throw error('invalid_service_manifest');
      const file=path.join(directory,unit.name),st=fs.lstatSync(file);
      if(st.isSymbolicLink()||st.uid!==process.getuid()||hash(fs.readFileSync(file))!==unit.sha256)throw error('service_file_changed');
    }return m;
  }
  async function register(){
    privateDir(state);const prior=owned();if(prior)return prior;
    const plan=linuxServicePlan(state,configurationFile,{repo,node});
    // Do not chmod the user's shared systemd unit directory.
    fs.mkdirSync(directory,{recursive:true,mode:0o700});
    if(fs.lstatSync(directory).isSymbolicLink()||fs.statSync(directory).uid!==process.getuid())throw error('service_directory_ownership_mismatch');
    for(const unit of plan.units)if(fs.existsSync(path.join(directory,unit.name)))throw error('service_name_conflict');
    const written=[];
    try{for(const unit of plan.units){const file=path.join(directory,unit.name);fs.writeFileSync(file,unit.text,{flag:'wx',mode:0o600});written.push(file);}writePrivate(manifestFile,plan);await call(['daemon-reload']);}
    catch(e){for(const file of written)fs.rmSync(file,{force:true});fs.rmSync(manifestFile,{force:true});throw e;}
    return plan;
  }
  return {
    async status(){
      if(!configurationFile)return {supported:false};
      const m=owned();if(!m)return {supported:true,startup:{registered:false,enabled:false,kind:'systemd-user'},services:[]};
      const rows=[];
      for(const u of m.units){
        const r=await call(['show',u.name,'-p','ActiveState','-p','SubState','-p','UnitFileState','-p','MainPID']);
        const s=Object.fromEntries(r.stdout.trim().split('\n').filter(x=>x.includes('=')).map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));
        rows.push({id:u.id,phase:s.ActiveState==='active'?'running':s.ActiveState==='activating'?'starting':s.ActiveState||'unknown',enabled:s.UnitFileState==='enabled'});
      }
      return {supported:true,startup:{registered:true,enabled:rows.every(x=>x.enabled),kind:'systemd-user'},supervisor:{phase:'systemd'},services:rows};
    },
    async action(action){
      if(!['enable','disable','start','stop','unregister'].includes(action))throw error('invalid_service_action');
      const m=action==='enable'?await register():owned();
      if(!m)throw error('service_registration_required');
      const names=m.units.map(x=>x.name);
      if(action==='enable')await call(['enable',...names]);
      if(action==='start'){
        const lock=path.join(state,'control.lock');
        if(fs.existsSync(lock)){const p=read(lock).pid;let live=false;try{process.kill(p,0);live=true;}catch{}
          if(live&&!process.env.INVOCATION_ID)throw error('stop_manual_control_before_service_start');}
        await call(['start',...names]);
      }
      if(action==='stop')await call(['stop',...names.slice().reverse()]);
      if(action==='disable')await call(['disable',...names]);
      if(action==='unregister'){
        for(const name of names){const r=await call(['show',name,'-p','ActiveState','--value']);if(['active','activating','deactivating'].includes(r.stdout.trim()))throw error('stop_owned_services_before_uninstall');}
        await call(['disable',...names]);for(const u of m.units)fs.unlinkSync(path.join(directory,u.name));fs.unlinkSync(manifestFile);await call(['daemon-reload']);
      }
      return {accepted:true,action,...(action==='enable'?{startsAt:'next-user-login'}:{}),startup:(await this.status()).startup};
    },
    plan:()=>linuxServicePlan(state,configurationFile,{repo,node})
  };
}
