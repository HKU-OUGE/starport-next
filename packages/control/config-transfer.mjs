import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {defaultConfig,relative,validateConfig} from '../config/model.mjs';
import {bundle,decodeBundle,preview} from '../config/portable.mjs';
import {encrypt} from '../config/crypto.mjs';
import {readJson,importProfile,exportProfile,loadProfile} from '../config/store.mjs';
import {privateDir,error} from '../runtime/common.mjs';

const nameOk=n=>typeof n==='string'&&n!=='current'&&/^[a-z][a-z0-9-]{0,47}$/.test(n);
const digest=value=>crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const resolve=(file,value)=>{if(!relative(value))throw error('relative_control_path_required');return path.resolve(path.dirname(file),value);};
function secret(file){
  const s=fs.lstatSync(file);if(!s.isFile()||s.isSymbolicLink()||s.size>65536)throw error('invalid_secret_file');
  return fs.readFileSync(file,'utf8').trim();
}
function cloudCredentials(file){
  const values={};
  for(const line of secret(file).split(/\r?\n/)){
    const m=/^\s*(accesskeyid|accesskeysecret|ststoken)\s*[=:]\s*(.*?)\s*$/.exec(line);
    if(m)values[m[1]]=m[2];
  }
  if(!values.accesskeyid||!values.accesskeysecret)throw error('unsupported_cloud_credential_file');
  return {accessKeyId:values.accesskeyid,accessKeySecret:values.accesskeysecret,...(values.ststoken?{securityToken:values.ststoken}:{})};
}

export function snapshotControl(file,{includeSecrets=false}={}){
  if(!file)throw error('current_configuration_unavailable');
  const host=readJson(file),config=defaultConfig('single-machine'),values={},warnings=[];
  if(host.format!=='starport-host-control'||host.version!==1)throw error('invalid_control_configuration');
  config.engine.model=host.model||'select-at-setup';config.engine.effort='low';
  config.workspace={kind:'wsl2',wslg:host.wslg===true};config.lifecycle.autoStart='disabled';
  if(includeSecrets&&host.apiKeyFile)values[config.engine.providerRef]={kind:'model-provider',provider:'anthropic-api',endpoint:'https://api.anthropic.com',token:secret(resolve(file,host.apiKeyFile))};
  if(host.nodesFile){
    config.network.subscriptionRefs=['secret://network-subscription'];config.network.selectionRef='secret://network-selection';
    if(includeSecrets){
      const nodes=readJson(resolve(file,host.nodesFile));
      values['secret://network-subscription']={kind:'subscription',nodes:nodes.nodes,hosts:nodes.hosts||{}};
      values['secret://network-selection']={kind:'node-selection',candidates:nodes.nodes.slice(0,8).map((_,nodeIndex)=>({subscriptionRef:'secret://network-subscription',nodeIndex}))};
    }
  }
  if(host.workerComputeFile){
    const workerFile=resolve(file,host.workerComputeFile),worker=readJson(workerFile),connectionFile=resolve(workerFile,worker.connectionFile),connection=readJson(connectionFile),p=worker.limits;
    if(worker.format!=='starport-worker-compute'||worker.version!==1||!['ssh','dsw'].includes(connection.mode))throw error('unsupported_worker_configuration');
    config.topology='desktop-dsw';config.computePolicy={cpus:p.cpus,memoryGiB:p.memory_gib,gpus:p.gpus,timeout:p.timeout,parallel:p.parallel??null};
    config.nodes=[{id:'compute',transport:connection.mode,connectionRef:'secret://compute-connection',runtime:'linux-gvisor',budget:{cpus:p.cpus,memoryGiB:p.memory_gib,gpus:Array.from({length:p.gpus},(_,i)=>i)}}];
    if(includeSecrets){
      const privateKey=secret(resolve(connectionFile,connection.identityFile));
      values['secret://compute-connection']=connection.mode==='dsw'?{kind:'dsw-connection',instanceId:connection.instanceId,region:connection.region,user:connection.user,privateKey,credentials:cloudCredentials(resolve(connectionFile,connection.credentialsFile))}:
        {kind:'ssh-connection',host:connection.user+'@'+connection.host,port:connection.port||22,privateKey};
    }
  }else if(host.compute)warnings.push('generic_compute_endpoint_requires_separate_setup');
  if(host.access)warnings.push('public_access_requires_separate_setup');
  warnings.push('new_device_requires_host_key_runtime_and_display_verification');
  return {value:bundle(validateConfig(config),values,{includeSecrets}),warnings};
}

export function createConfigurationTransfer(state,configurationFile){
  const directory=privateDir(path.join(state,'imported-profiles')),previews=new Map();let busy=false;
  const target=name=>{if(!nameOk(name))throw error('invalid_profile_name');return path.join(directory,name);};
  return {
    async list(){
      const profiles=[];
      for(const entry of fs.readdirSync(directory,{withFileTypes:true})){
        if(!entry.isDirectory()||entry.isSymbolicLink()||!nameOk(entry.name))continue;
        try{const p=target(entry.name),loaded=await loadProfile(p);profiles.push({name:entry.name,model:loaded.config.engine.model,encrypted:fs.existsSync(path.join(p,'vault.spx'))});}catch{}
      }
      return {currentAvailable:Boolean(configurationFile),profiles};
    },
    async handle(action,b){
      if(busy)throw error('configuration_operation_busy');busy=true;
      try{
        if(action==='preview'){
          const decoded=await decodeBundle(b.bundle,b.password),value=preview(decoded),token=crypto.randomBytes(24).toString('hex');
          for(const [key,old] of previews)if(old.expires<Date.now())previews.delete(key);
          if(previews.size>=8)previews.delete(previews.keys().next().value);
          previews.set(token,{digest:digest(b.bundle),expires:Date.now()+600000});
          return {previewToken:token,preview:value,model:decoded.config.engine.model,workspace:decoded.config.workspace,computePolicy:decoded.config.computePolicy};
        }
        if(action==='import'){
          const record=previews.get(b.previewToken);
          if(!record||record.expires<Date.now()||record.digest!==digest(b.bundle))throw error('configuration_preview_required');
          const result=await importProfile(target(b.name),b.bundle,b.password);previews.delete(b.previewToken);
          return {...result,name:b.name,activated:false};
        }
        if(action==='export'){
          if(typeof b.includeSecrets!=='boolean')throw error('invalid_export_mode');
          let value,warnings=[];
          if(b.source==='current'){
            const snapshot=snapshotControl(configurationFile,{includeSecrets:b.includeSecrets});warnings=snapshot.warnings;
            value=b.includeSecrets?await encrypt(snapshot.value,b.password):snapshot.value;
          }else value=await exportProfile(target(b.source),b.password,{includeSecrets:b.includeSecrets});
          return {filename:`starport-${b.source}-${b.includeSecrets?'encrypted.spx':'config.json'}`,encrypted:b.includeSecrets,bundle:value,warnings};
        }
        throw error('configuration_route_not_allowed');
      }finally{busy=false;}
    }
  };
}
