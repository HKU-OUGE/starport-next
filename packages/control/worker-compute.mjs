// Protocol adapter for an independent Starport Next worker. SSH remains operator-side.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {privateDir,writePrivate,read,error} from '../runtime/common.mjs';
import {bodyJson,jsonResponse,projectPath} from './compute.mjs';

const id=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
const code=e=>/^[a-z][a-z0-9_]{1,79}$/.test(e?.message||'')?e.message:'worker_compute_failed';
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'";
const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
export function workerJob(v){
  return {id:v.id,status:v.status,created_at:v.created_at,started_at:v.started_at,
    finished_at:v.ended_at,exit_code:v.exit_code,resources_released:v.released===true,
    ...(v.error?{error:code({message:v.error})}:{})};
}
export function workerRequest(value,limits){
  const allowed=['files','entry','args','cpus','memory_gib','gpus','timeout','language'];
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!allowed.includes(k)))throw error('worker_compute_unsupported_request');
  const files=value.files;
  if(!files||typeof files!=='object'||Array.isArray(files)||!Object.keys(files).length||Object.keys(files).length>16||!projectPath(value.entry)||!Object.hasOwn(files,value.entry))throw error('invalid_job_files');
  let bytes=0;const decoded=[];
  for(const [name,data] of Object.entries(files)){
    if(!projectPath(name)||typeof data!=='string'||data.length%4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))throw error('invalid_job_files');
    const b=Buffer.from(data,'base64');bytes+=b.length;if(bytes>16*1024*1024)throw error('job_upload_too_large');decoded.push([name,b]);
  }
  const args=value.args??[];
  if(!Array.isArray(args)||args.length>128||args.some(s=>typeof s!=='string'||s.length>4096||s.includes('\0')))throw error('invalid_arguments');
  const resources={cpus:value.cpus??1,memory_gib:value.memory_gib??2,gpus:value.gpus??0,timeout:value.timeout??120};
  for(const [key,n] of Object.entries(resources))if(!Number.isInteger(n)||n<(key==='gpus'?0:1)||n>limits[key])throw error('compute_resource_limit');
  const language=value.language??'python';
  if(!['python','bash'].includes(language))throw error('unsupported_job_language');
  const executable=language==='python'?'python3':'bash';
  return {files:decoded,resources,command:[executable,'/workspace/'+value.entry,...args].map(quote).join(' '),config:{entry:value.entry,args,...resources,language}};
}

export async function createWorkerComputeBridge({state,token,binding,remoteFactory,limits,port=0}){
  privateDir(state);
  if(typeof token!=='string'||token.length<32||!binding||!remoteFactory)throw error('invalid_worker_bridge_configuration');
  for(const k of ['cpus','memory_gib','gpus','timeout'])if(!Number.isInteger(limits?.[k])||limits[k]<(k==='gpus'?0:1))throw error('invalid_worker_bridge_limits');
  if(limits.parallel!=null&&(!Number.isInteger(limits.parallel)||limits.parallel<1))throw error('invalid_worker_bridge_limits');
  const file=path.join(state,'jobs.json');
  const db=fs.existsSync(file)?read(file):{binding,requests:{},jobs:{}};
  if(db.binding!==binding)throw error('worker_connection_changed_reconcile_first');
  const save=()=>writePrivate(file,db);save();
  let pending=0,healthPromise;
  async function health(){
    if(healthPromise)return healthPromise;
    healthPromise=(async()=>{
      const h=await remoteFactory().call('health');
      return {ready:h.ready===true&&h.egress_ready===true,accepting_new_jobs:h.ready===true&&h.egress_ready===true,
        limits:{server_max_cpus:Math.min(h.cpus,limits.cpus),server_max_memory_gib:Math.min(h.memory_gib,limits.memory_gib),server_max_gpus:Math.min(h.gpus,limits.gpus),max_timeout:limits.timeout},
        configuredLimits:{cpus:limits.cpus,memory_gib:limits.memory_gib,gpus:limits.gpus,timeout:limits.timeout},
        max_parallel:limits.parallel??null,max_parallel_server:limits.parallel??null};
    })();
    try{return await healthPromise;}finally{healthPromise=null;}
  }
  async function status(job){
    const row=db.jobs[job];if(!row)throw error('job_not_found');
    const value=workerJob(await remoteFactory(row.workspace).call('job.status',{job}));row.cached=value;save();return value;
  }
  async function submit(input){
    const request=workerRequest(input,limits);
    if(pending)throw error('compute_submission_busy');
    pending++;
    let receipt;
    try{
      // Unknown submissions reserve admission until the operator reconciles them.
      if(Object.values(db.requests).some(r=>r.phase!=='complete'&&r.phase!=='failed'))throw error('compute_outcome_unknown_check_before_retry');
      for(const [job,row] of Object.entries(db.jobs))if(!row.cached?.resources_released)await status(job);
      if(limits.parallel!=null&&Object.values(db.jobs).filter(r=>!r.cached?.resources_released).length+pending>limits.parallel)throw error('compute_capacity');
      if(!(await health()).ready)throw error('compute_unavailable');
      const requestId=crypto.randomBytes(16).toString('hex');
      receipt=db.requests[requestId]={phase:'creating_workspace',createdAt:new Date().toISOString()};save();
      const created=await remoteFactory().call('workspace.create');
      if(!id(created.id))throw error('invalid_remote_workspace');
      receipt.workspace=created.id;receipt.phase='uploading';save();
      const remote=remoteFactory(created.id);
      for(const [name,b] of request.files){
        const upload=await remote.call('upload.begin',{path:name,bytes:b.length,sha256:sha(b)});
        if(!id(upload.id))throw error('invalid_upload_response');
        for(let offset=0;offset<b.length;offset+=1024*1024){const chunk=b.subarray(offset,offset+1024*1024);await remote.call('upload.chunk',{upload:upload.id,offset,data:chunk.toString('base64'),sha256:sha(chunk)});}
        const done=await remote.call('upload.finish',{upload:upload.id});
        if(done.sha256!==sha(b)||done.bytes!==b.length)throw error('upload_integrity');
      }
      receipt.phase='submitting';save();
      const result=await remote.call('job.submit',{command:request.command,...request.resources});
      if(!id(result.id))throw error('invalid_job_response');
      const value=workerJob(result);
      db.jobs[result.id]={workspace:created.id,config:request.config,cached:value};receipt.job=result.id;receipt.phase='complete';save();
      return value;
    }catch(e){
      if(receipt){receipt.error=code(e);receipt.phase=!e.outcomeKnown&&(receipt.phase==='submitting'||receipt.phase==='creating_workspace')?'outcome_unknown':'failed';save();}
      throw error(receipt?.phase==='outcome_unknown'?'compute_outcome_unknown_check_before_retry':code(e));
    }finally{pending--;}
  }
  const server=http.createServer(async(req,res)=>{
    if(req.headers.origin||!same(req.headers.authorization,'Bearer '+token))return jsonResponse(res,401,{error:'authentication_required'});
    const u=new URL(req.url,'http://bridge.invalid'),parts=u.pathname.split('/').filter(Boolean);
    try{
      if(req.method==='GET'&&u.pathname==='/health')return jsonResponse(res,200,await health());
      if(req.method==='POST'&&u.pathname==='/jobs')return jsonResponse(res,201,await submit(await bodyJson(req,24*1024*1024)));
      if(parts[0]!=='jobs'||!id(parts[1])||!db.jobs[parts[1]])throw error('job_not_found');
      const job=parts[1],row=db.jobs[job],remote=remoteFactory(row.workspace);
      if(req.method==='GET'&&parts.length===2){const v=await status(job);if(v.resources_released)v.artifacts=(await remote.call('job.artifacts',{job})).artifacts;return jsonResponse(res,200,v);}
      if(req.method==='GET'&&parts.length===3&&parts[2]==='config')return jsonResponse(res,200,row.config);
      if(req.method==='GET'&&parts.length===3&&parts[2]==='logs'){
        if([...u.searchParams.keys()].some(k=>!['cursor','after','limit'].includes(k)))throw error('invalid_query');
        const cursor=Number(u.searchParams.get('cursor')??u.searchParams.get('after')??0);
        if(!Number.isSafeInteger(cursor)||cursor<0)throw error('invalid_cursor');
        const v=await remote.call('job.logs',{job,cursor});return jsonResponse(res,200,{...v,next_cursor:v.cursor});
      }
      if(req.method==='POST'&&parts.length===3&&parts[2]==='cancel'){
        await remote.call('job.cancel',{job});return jsonResponse(res,200,{id:job,cancel:{requested:true}});
      }
      if(req.method==='GET'&&parts.length>=4&&parts[2]==='artifact'){
        const name=decodeURIComponent(parts.slice(3).join('/'));if(!projectPath(name))throw error('invalid_artifact_path');
        if(!(await status(job)).resources_released)throw error('artifact_requires_finished_job');
        let offset=0,version,total;
        do{
          const v=await remote.call('artifact.read',{job,path:name,offset,size:1024*1024,...(version?{version}:{})});
          const b=Buffer.from(v.data,'base64');
          if(v.offset!==offset||v.bytes!==b.length||sha(b)!==v.sha256||!Number.isSafeInteger(v.total)||v.total<offset+b.length||total!==undefined&&v.total!==total||version&&v.version!==version||!b.length&&offset<v.total)throw error('artifact_integrity');
          version=v.version;total=v.total;offset+=b.length;
          if(!res.headersSent)res.writeHead(200,{'content-type':'application/octet-stream','content-length':total,'cache-control':'no-store'});
          if(!res.write(b))await new Promise((resolve,reject)=>{const closed=()=>reject(error('artifact_client_disconnected'));res.once('close',closed);res.once('drain',()=>{res.off('close',closed);resolve();});});
        }while(offset<total);
        return res.end();
      }
      throw error('compute_route_not_allowed');
    }catch(e){if(res.headersSent)res.destroy();else jsonResponse(res,503,{error:code(e)});}
  });
  server.requestTimeout=180000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {port:server.address().port,health,close(){server.closeAllConnections();server.close();}};
}
