import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDir,read,writePrivate,error} from '../runtime/common.mjs';
import {VERSION,defaultFeatures,validatePlan,publicPlan,stageList} from './plan.mjs';
import {installation,claim,targetPath,payload,copyPayload,assertNoMounts,assertLayout,acquireLock} from './owned-files.mjs';
import * as system from './driver.mjs';
import {selectNodes} from './subscription.mjs';

export function createInstaller({root,source,platform=process.platform,driver=system}){
  root=targetPath(root);source=path.resolve(source);let running=false,progress={phase:'idle',stage:null,completed:[],error:null},subscription=null;
  const receiptFile=path.join(root,'installation.json'),settingsFile=path.join(root,'private/setup/options.json'),configFile=path.join(root,'private/host-control.json');
  const remember=()=>{if(fs.existsSync(path.join(root,'private/setup')))writePrivate(path.join(root,'private/setup/progress.json'),progress);};
  function snapshot(){
    const r=installation(root),settings=fs.existsSync(settingsFile)?read(settingsFile):null;
    return {version:VERSION,platform,architecture:process.arch,target:root,installed:r?.phase==='installed',existing:!!r&&r.phase!=='uninstalled',installationId:r?.id||null,installedVersion:r?.version||null,running,progress,settings:settings||{features:defaultFeatures,credentialStorage:'keyring',port:18884,cpus:2,memoryMiB:4096,diskGiB:24,model:'claude-sonnet-4-6',nodeIndexes:[]},savedNetwork:fs.existsSync(path.join(root,'private/network/nodes.json'))};
  }
  function network(value){if(running)throw error('installation_busy');subscription=value;return value.nodes.map((n,i)=>({index:i,name:String(n.name||'节点 '+(i+1)).slice(0,120),type:n.type}));}
  function existingNetwork(){const file=path.join(root,'private/network/nodes.json');return fs.existsSync(file)?read(file):null;}
  function writeConfiguration(p,selected){
    const priv=privateDir(path.join(root,'private'));privateDir(path.join(priv,'setup'));privateDir(path.join(priv,'secrets'));privateDir(path.join(priv,'network'));privateDir(path.join(priv,'bin'));
    const saveSecret=(name,value,required=true)=>{const file=path.join(priv,'secrets',name);if(value)writePrivate(file,value.endsWith('\n')?value:value+'\n');if(required&&!fs.existsSync(file))throw error('required_connection_secret_missing');return 'secrets/'+name;};
    const c={format:'starport-host-control',version:1,port:p.port,runtime:{kind:platform==='win32'?'wsl2':'qemu',state:platform==='win32'?'wsl':'qemu'},workspaceEnabled:p.features.workspace,wslg:platform==='win32'&&p.features.seamless,seamless:platform==='linux'&&p.features.seamless,seamlessClipboard:p.features.clipboard?'text':'disabled',credentialStorage:p.credentialStorage};
    if(selected){writePrivate(path.join(priv,'network/nodes.json'),selected);c.nodesFile='network/nodes.json';c.proxyBinary='bin/mihomo'+(platform==='win32'?'.exe':'');}
    if(p.features.api){c.apiKeyFile=saveSecret('api-key.txt',p.apiKey);c.model=p.model;}
    if(p.features.compute){const v=p.compute;c.computeNodes=[{id:'server',name:'计算服务器',tokenFile:saveSecret('compute-token.txt',v.token),ssh:{host:v.host,user:v.user,port:v.sshPort,serverPort:v.serverPort,identityFile:saveSecret('compute-key',v.privateKey),knownHostsFile:saveSecret('compute-hosts',v.knownHosts)}}];c.defaultComputeNode='server';}
    if(p.features.remote){const r=p.remote;c.access={hostname:r.hostname,issuer:r.issuer,audience:r.audience,allowedEmails:r.emails};c.tunnel={tokenFile:saveSecret('tunnel-token.txt',r.token),binary:'bin/cloudflared'+(platform==='win32'?'.exe':'')};}
    if(fs.existsSync(configFile))fs.copyFileSync(configFile,path.join(priv,'setup/previous-host-control.json'));
    writePrivate(configFile,c);
    const publicSettings=publicPlan(p);if(p.features.api)publicSettings.apiKey='saved';if(publicSettings.compute)for(const k of ['privateKey','knownHosts','token'])publicSettings.compute[k]='saved';if(publicSettings.remote)publicSettings.remote.token='saved';publicSettings.nodeIndexes=selected?selected.nodes.map((_,i)=>i):[];writePrivate(settingsFile,publicSettings);
  }
  async function apply(input){
    if(running)throw error('installation_busy');const p=validatePlan(input,platform);
    running=true;progress={phase:'installing',stage:'files',completed:[],error:null,stages:stageList(p)};
    let receipt,releaseLock;
    try{
      const prior=installation(root),selected=subscription?await selectNodes(subscription,p.nodeIndexes):existingNetwork();
      if(p.features.workspace&&!selected)throw error('choose_proxy_node');
      const required=[...(p.features.api?[['api-key.txt',p.apiKey]]:[]),...(p.features.compute?[['compute-key',p.compute.privateKey],['compute-hosts',p.compute.knownHosts],['compute-token.txt',p.compute.token]]:[]),...(p.features.remote?[['tunnel-token.txt',p.remote.token]]:[])];
      for(const [name,value] of required)if(!value&&!fs.existsSync(path.join(root,'private/secrets',name)))throw error('required_connection_secret_missing');
      if(prior)await driver.ensureIdle(root);
      const bundle=await payload(source,platform);if(bundle.version!==VERSION)throw error('release_version_mismatch');
      receipt=claim(root);assertLayout(root);releaseLock=acquireLock(root,receipt.id);
      if(prior)await driver.stopOwned(root);
      for(const stage of progress.stages){
        progress={...progress,stage,detail:null};remember();
        if(stage==='files')await copyPayload(source,root,bundle);
        else if(stage==='configuration')writeConfiguration(p,selected);
        else if(stage!=='complete')await driver.runStage(stage,{root,plan:p,progress:value=>{progress.detail=typeof value==='object'?{bytes:value.bytes,total:value.total,phase:value.phase}:null;remember();}});
        progress.completed.push(stage);remember();
      }
      writePrivate(receiptFile,{...receipt,phase:'installed',version:VERSION,features:p.features,updatedAt:new Date().toISOString()});progress.phase='complete';remember();return snapshot();
    }catch(e){const code=/^[a-z][a-z0-9_]{1,100}$/.test(e.code||'')?e.code:'install_step_failed';progress={...progress,phase:['system_restart_required','login_required_for_kvm'].includes(code)?'restart-required':'failed',error:code};if(receipt&&releaseLock)writePrivate(receiptFile,{...receipt,phase:progress.phase,version:VERSION,failedStage:progress.stage});remember();throw error(code);}
    finally{running=false;releaseLock?.();}
  }
  async function uninstall({deleteData=false,confirmId}){
    if(running)throw error('installation_busy');if(typeof deleteData!=='boolean')throw error('explicit_data_deletion_choice_required');const r=installation(root);if(!r||confirmId!==r.id)throw error('installation_confirmation_required');
    assertLayout(root);const releaseLock=acquireLock(root,r.id);running=true;progress={phase:'uninstalling',stage:'stop-services',completed:[],error:null};
    try{
      await driver.ensureIdle(root);assertNoMounts(root);await driver.uninstallRuntime(root,{deleteData});assertNoMounts(root);
      // App/runtime/backups are installer-owned; private is a separate, explicit choice.
      const names=['app','runtime','backups','payload-manifest.json'];if(deleteData)names.push('private');
      for(const name of names){const file=path.join(root,name);if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw error('uninstall_symlink_rejected');}
      for(const name of names)fs.rmSync(path.join(root,name),{recursive:true,force:true});
      writePrivate(receiptFile,{...r,phase:'uninstalled',dataPreserved:!deleteData});progress={phase:'uninstalled',stage:'complete',completed:[],error:null};return snapshot();
    }catch(e){progress.phase='failed';progress.error=e.code||'uninstall_failed';throw e;}finally{running=false;releaseLock();}
  }
  return {snapshot,apply,uninstall,network,existingNetwork,root,source};
}
