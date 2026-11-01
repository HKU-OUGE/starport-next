import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {run,executable,cleanEnv,error,sleep} from '../runtime/common.mjs';

const proxyScript=fileURLToPath(new URL('../../scripts/dsw-proxy.py',import.meta.url));
const quote=v=>'"'+String(v).replaceAll('\\','/').replaceAll('"','\\"').replaceAll('%','%%')+'"';
export function workerSshArgs(c,connectionFile,{forward=false}={}){
  if(!['ssh','dsw'].includes(c.mode)||!/^[_a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.user||'')||!c.identityFile||!c.knownHostsFile)throw error('invalid_worker_connection');
  const args=['-F',process.platform==='win32'?'NUL':'/dev/null','-T','-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','ForwardAgent=no','-o','SendEnv=-*','-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile=${quote(c.knownHostsFile)}`,'-o','GlobalKnownHostsFile=none','-o','ConnectTimeout=12','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3','-i',c.identityFile];
  if(!forward)args.push('-o','ClearAllForwardings=yes');
  if(c.mode==='dsw'){
    if(!/^dsw-[a-z0-9]{12,64}$/.test(c.instanceId||'')||!/^[-a-z0-9]{2,50}$/.test(c.region||'')||!/^[-a-zA-Z0-9]{1,100}$/.test(c.hostKeyAlias||'')||!c.python)throw error('invalid_dsw_connection');
    args.push('-o','ProxyCommand='+[c.python,proxyScript,'--config',connectionFile].map(quote).join(' '),'-o','HostKeyAlias='+c.hostKeyAlias,`${c.user}@starport-worker`);
  }else{
    if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.host||'')||!Number.isInteger(c.port||22)||(c.port||22)<1||(c.port||22)>65535)throw error('invalid_worker_host');
    args.push('-p',String(c.port||22),`${c.user}@${c.host}`);
  }
  return args;
}
export class WorkerRemote{
  constructor(connection,connectionFile,workspace){this.connection=connection;this.connectionFile=connectionFile;this.workspace=workspace;}
  async call(operation,parameters={}){
    const readOnly=['health','resource.list','job.status','job.logs','job.artifacts','artifact.read'];
    const allowed=[...readOnly,'resource.register','resource.disable','resource.auto_conda','egress.reset','workspace.create','job.submit','job.cancel','upload.begin','upload.chunk','upload.finish'];
    if(!allowed.includes(operation))throw error('unsupported_worker_operation');
    const body={...parameters,operation};
    if(!['health','egress.reset','workspace.create','resource.list','resource.register','resource.disable','resource.auto_conda'].includes(operation)){if(!/^[a-f0-9]{32}$/.test(this.workspace||''))throw error('worker_workspace_required');body.workspace=this.workspace;}
    let result;
    try{result=await run(executable('ssh'),[...workerSshArgs(this.connection,this.connectionFile),'python3 -I "$HOME/.local/share/starport-next-worker/worker.py" rpc'],{input:JSON.stringify(body),timeout:45000,maxBytes:8*1024*1024});}
    catch{throw error(readOnly.includes(operation)?'worker_unavailable':'worker_outcome_unknown');}
    if(result.code!==0)throw error(readOnly.includes(operation)?'worker_unavailable':'worker_outcome_unknown');
    let v;try{v=JSON.parse(result.stdout);}catch{throw error(readOnly.includes(operation)?'invalid_worker_response':'worker_outcome_unknown');}
    if(!v.ok)throw Object.assign(error(/^[a-z][a-z0-9_]{1,79}$/.test(v.error||'')?v.error:'worker_operation_failed'),{outcomeKnown:true});
    return v.result;
  }
  async tunnel(proxyPort){
    const h=await this.call('health');
    if(!/^\/tmp\/starport-egress-[a-f0-9]{32}\/proxy\.sock$/.test(h.egress_socket||''))throw error('invalid_worker_egress');
    if(h.egress_ready)throw error('worker_egress_already_owned_reconcile_first');
    await this.call('egress.reset');
    const args=workerSshArgs(this.connection,this.connectionFile,{forward:true});
    args.splice(args.length-1,0,'-N','-o','ExitOnForwardFailure=yes','-o','StreamLocalBindUnlink=yes','-o','StreamLocalBindMask=0111','-R',`${h.egress_socket}:127.0.0.1:${proxyPort}`);
    const child=spawn(executable('ssh'),args,{shell:false,windowsHide:true,env:cleanEnv(),stdio:'ignore'});let failed=false;child.on('error',()=>{failed=true;});
    for(let i=0;i<10;i++){await sleep(500);if(failed||child.exitCode!==null)throw error('worker_egress_failed');if((await this.call('health')).egress_ready)return {close:()=>child.kill()};}
    child.kill();throw error('worker_egress_timeout');
  }
}
export function loadWorkerConnection(file){
  const c=JSON.parse(fs.readFileSync(file,'utf8')),base=path.dirname(file);
  for(const key of ['identityFile','knownHostsFile','proxyClient','credentialsFile','python'])if(c[key])c[key]=path.resolve(base,c[key]);
  for(const key of ['identityFile','knownHostsFile',...(c.mode==='dsw'?['proxyClient','credentialsFile','python']:[])]){const st=fs.lstatSync(c[key]);if(!st.isFile()||st.isSymbolicLink())throw error('worker_material_required');}
  workerSshArgs(c,file);return c;
}
