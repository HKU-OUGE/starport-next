import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { error,writePrivate,read } from '../runtime/common.mjs';

const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const jobId=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
export function projectPath(p){return typeof p==='string'&&p.length<=512&&!/[\\\x00-\x1f]/.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');}
const safeCode=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(v)?v:'compute_operation_failed';
const publicFields=(v,names)=>Object.fromEntries(names.filter(n=>v?.[n]!==undefined).map(n=>[n,v[n]]));
const statusFields=['status','created_at','started_at','finished_at','exit_code','failure_phase','last_control_heartbeat_at','resources_released','cancel'];
export function publicJob(value){
  const out=publicFields(value,statusFields);
  if(jobId(value?.id))out.id=value.id;
  if(value?.error)out.error=safeCode(value.error);
  if(Array.isArray(value?.artifacts))out.artifacts=value.artifacts.filter(a=>projectPath(a.path)).map(a=>publicFields(a,['path','bytes','sha256']));
  return out;
}
export async function bodyJson(req,max=96*1024*1024){
  const chunks=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>max)throw error('request_too_large');chunks.push(chunk);}
  return chunks.length?JSON.parse(Buffer.concat(chunks)):{};
}
export function jsonResponse(res,status,value){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(value));}

export async function createCompute({state,connection,fetcher=fetch}){
  const file=path.join(state,'compute-jobs.json'),registry=fs.existsSync(file)?read(file):{},tokens=new Map();
  let base;
  if(connection){
    base=new URL(connection.url);
    // Remote administrative SSH remains operator-side. This adapter only accepts
    // a loopback endpoint of the existing, verified isolated training API.
    if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.pathname!=='/'||base.search||base.hash||base.username||base.password||!connection.token)
      throw error('loopback_isolated_compute_endpoint_required');
  }
  async function upstream(method,route,payload){
    if(!base)throw error('compute_not_configured');
    let r;try{r=await fetcher(new URL(route,base),{method,headers:{authorization:'Bearer '+connection.token,'content-type':'application/json'},
      body:payload===undefined?undefined:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(30000)});}catch{throw error(method==='POST'?'compute_outcome_unknown_check_before_retry':'compute_unavailable');}
    return r;
  }
  async function health(){
    if(!base)return {ready:false,error:'compute_not_configured'};
    try{
      const r=await upstream('GET','/health');if(!r.ok)throw error('compute_unavailable');const v=await r.json();
      // Management endpoint, instance IDs, filesystem roots and provider metadata
      // are intentionally not included in the workspace-facing health schema.
      return {ready:v.ready===true,acceptingNewJobs:v.accepting_new_jobs===true,
        limits:publicFields(v.limits,['server_max_cpus','server_max_memory_gib','max_timeout']),
        capacity:publicFields(v,['max_parallel','max_parallel_server','max_parallel_local'])};
    }catch{return {ready:false,error:'compute_unavailable'};}
  }
  const server=http.createServer(async(req,res)=>{
    let scope;for(const [workspace,token] of tokens)if(same(req.headers.authorization,'Bearer '+token))scope=workspace;
    if(!scope||req.headers.origin)return jsonResponse(res,401,{error:'project_capability_required'});
    const url=new URL(req.url,'http://project.invalid'),parts=url.pathname.split('/').filter(Boolean);
    try{
      if(req.method==='GET'&&url.pathname==='/health')return jsonResponse(res,200,await health());
      if(req.method==='GET'&&url.pathname==='/jobs')return jsonResponse(res,200,{jobs:Object.entries(registry).filter(([,v])=>v.workspace===scope).map(([id,v])=>({id,...publicJob(v.cached||{}),outcomeUnknown:!!v.outcomeUnknown}))});
      if(req.method==='POST'&&url.pathname==='/jobs'){
        const d=await bodyJson(req);const allowed=['files','entry','args','timeout','target','node','gpus','cpus','memory_gib','distributed','environment','backend','dependency_layer','data_ids','queue_timeout','setup_timeout','language'];
        if(!d||Array.isArray(d)||Object.keys(d).some(k=>!allowed.includes(k))||!d.files||Array.isArray(d.files)||Object.keys(d.files).length>1000||Object.keys(d.files).some(p=>!projectPath(p)))throw error('invalid_job_request');
        if(d.entry&&!projectPath(d.entry))throw error('invalid_entry');
        if(d.args&&(!Array.isArray(d.args)||d.args.some(a=>typeof a!=='string'||a.includes('\0'))))throw error('invalid_arguments');
        const requestId=crypto.randomBytes(16).toString('hex');
        registry[requestId]={workspace:scope,outcomeUnknown:true,submittedAt:new Date().toISOString()};writePrivate(file,registry);
        const r=await upstream('POST','/jobs',d),v=await r.json();
        if(!r.ok){delete registry[requestId];writePrivate(file,registry);return jsonResponse(res,r.status,{error:safeCode(v.error)});}
        if(!jobId(v.id))throw error('compute_invalid_job_response');
        registry[v.id]={workspace:scope,cached:publicJob(v)};delete registry[requestId];writePrivate(file,registry);
        return jsonResponse(res,201,publicJob(v));
      }
      if(parts[0]!=='jobs'||!jobId(parts[1])||registry[parts[1]]?.workspace!==scope)throw error('job_outside_project');
      const id=parts[1];
      if(req.method==='POST'&&parts.length===3&&parts[2]==='cancel'){
        const r=await upstream('POST',`/jobs/${id}/cancel`,{}),v=await r.json();
        return jsonResponse(res,r.status,r.ok?publicJob(v):{error:safeCode(v.error)});
      }
      if(req.method!=='GET')throw error('compute_route_not_allowed');
      if(parts.length===2||parts.length===3&&['logs','config'].includes(parts[2])){
        if([...url.searchParams.keys()].some(k=>!['cursor','after','limit'].includes(k)))throw error('invalid_query');
        const r=await upstream('GET',url.pathname+url.search),v=await r.json();
        if(!r.ok)return jsonResponse(res,r.status,{error:safeCode(v.error)});
        const value=parts.length===2?publicJob(v):parts[2]==='logs'?publicFields(v,['text','cursor','next_cursor','truncated','done','bytes']):publicFields(v,['entry','args','gpus','cpus','memory_gib','timeout','environment','backend']);
        if(parts.length===2){registry[id].cached=value;writePrivate(file,registry);}
        return jsonResponse(res,200,value);
      }
      if(parts[2]==='artifact'&&projectPath(decodeURIComponent(parts.slice(3).join('/')))){
        const r=await upstream('GET',url.pathname);if(!r.ok)return jsonResponse(res,r.status,{error:'artifact_unavailable'});
        res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});
        for await(const chunk of r.body){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}return res.end();
      }
      throw error('compute_route_not_allowed');
    }catch(e){return jsonResponse(res,e.code==='job_outside_project'?403:503,{error:safeCode(e.code)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,health,capability(workspace){if(!tokens.has(workspace))tokens.set(workspace,crypto.randomBytes(32).toString('hex'));return tokens.get(workspace);},
    jobs:()=>Object.entries(registry).map(([id,v])=>({id,workspace:v.workspace,...publicJob(v.cached||{}),outcomeUnknown:!!v.outcomeUnknown})),
    close(){tokens.clear();server.closeAllConnections();server.close();}};
}
