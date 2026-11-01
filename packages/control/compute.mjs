import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { error,writePrivate,read } from '../runtime/common.mjs';
import { nodeId,connectionBinding } from './compute-nodes.mjs';

const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
const jobId=v=>typeof v==='string'&&/^[a-f0-9]{32}$/.test(v);
export function projectPath(p){return typeof p==='string'&&p.length<=512&&!/[\\\x00-\x1f]/.test(p)&&p.split('/').every(s=>s&&s!=='.'&&s!=='..');}
const safeCode=v=>typeof v==='string'&&/^[a-z][a-z0-9_]{0,79}$/.test(v)?v:'compute_operation_failed';
const publicFields=(v,names)=>Object.fromEntries(names.filter(n=>v?.[n]!==undefined).map(n=>[n,v[n]]));
const statusFields=['status','created_at','started_at','finished_at','exit_code','failure_phase','last_control_heartbeat_at','resources_released','cancel'];
const configFields=['entry','args','gpus','cpus','memory_gib','timeout','language','environment','backend'];
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

export async function createCompute({state,connection,connections,defaultNode,fetcher=fetch}){
  const file=path.join(state,'compute-jobs.json'),registry=fs.existsSync(file)?read(file):{},tokens=new Map();
  if(connection&&connections)throw error('choose_compute_or_compute_nodes');
  const list=connections||(connection?[{...connection,id:'primary',name:'主服务器'}]:[]);
  if(!Array.isArray(list)||list.length>32||new Set(list.map(n=>n.id)).size!==list.length)throw error('invalid_compute_nodes');
  if(defaultNode===undefined)defaultNode=list.length===1?list[0].id:null;
  if(defaultNode!==null&&!list.some(n=>n.id===defaultNode))throw error('invalid_default_compute_node');
  const settingsFile=path.join(state,'compute-nodes.json');
  const settings=fs.existsSync(settingsFile)?read(settingsFile):{version:1,nodes:{}};
  if(settings.version!==1||!settings.nodes||Array.isArray(settings.nodes))throw error('invalid_compute_node_registry');
  const nodes=new Map(),endpoints=new Set();
  for(const c of list){
    if(!nodeId(c.id)||!c.token)throw error('invalid_compute_node');
    let base;
    if(c.url){base=new URL(c.url);
      if(base.protocol!=='http:'||base.hostname!=='127.0.0.1'||!base.port||base.pathname!=='/'||base.search||base.hash||base.username||base.password)throw error('loopback_isolated_compute_endpoint_required');
      if(endpoints.has(base.href))throw error('duplicate_compute_endpoint');endpoints.add(base.href);}
    else if(!c.unavailable)throw error('loopback_isolated_compute_endpoint_required');
    const binding=c.binding||connectionBinding({url:c.url,token:c.token});
    const old=settings.nodes[c.id];
    if(!old)settings.nodes[c.id]={binding,paused:false};
    nodes.set(c.id,{...c,base,binding,mismatch:!!old&&old.binding!==binding});
  }
  // Historical jobs are permanently attributed to the old primary connection.
  // A differently named first node must never silently adopt that history.
  let migrated=false;
  for(const row of Object.values(registry))if(!row.node){row.node='primary';migrated=true;}
  if(migrated)writePrivate(file,registry);
  writePrivate(settingsFile,settings);
  function required(id){
    const n=nodes.get(id);if(!n)throw error('compute_node_not_configured');
    if(n.mismatch)throw error('compute_node_connection_changed_reconcile_first');
    if(!n.base||n.unavailable)throw error('compute_unavailable');return n;
  }
  const view=(id,v)=>({...publicJob(v.cached||{}),id,node:v.node,workspace:v.workspace,outcomeUnknown:!!v.outcomeUnknown,submittedAt:v.submittedAt,checkedAt:v.checkedAt,config:v.config});
  async function upstream(node,method,route,payload){
    const n=required(node);
    let r;try{r=await fetcher(new URL(route,n.base),{method,headers:{authorization:'Bearer '+n.token,'content-type':'application/json'},
      body:payload===undefined?undefined:JSON.stringify(payload),redirect:'error',signal:AbortSignal.timeout(method==='POST'?180000:30000)});}catch{throw error(method==='POST'?'compute_outcome_unknown_check_before_retry':'compute_unavailable');}
    return r;
  }
  async function nodeHealth(n){
    const paused=settings.nodes[n.id].paused===true,base={id:n.id,name:n.name||n.id,paused,checkedAt:new Date().toISOString()};
    try{
      const r=await upstream(n.id,'GET','/health');if(!r.ok)throw error('compute_unavailable');const v=await r.json();
      // Management endpoint, instance IDs, filesystem roots and provider metadata
      // are intentionally not included in the workspace-facing health schema.
      return {...base,ready:v.ready===true,acceptingNewJobs:v.accepting_new_jobs===true&&!paused,
        limits:publicFields(v.limits,['server_max_cpus','server_max_memory_gib','server_max_gpus','max_timeout']),
        configuredLimits:publicFields(v.configuredLimits,['cpus','memory_gib','gpus','timeout']),
        capacity:publicFields(v,['max_parallel','max_parallel_server','max_parallel_local'])};
    }catch(e){return {...base,ready:false,acceptingNewJobs:false,error:safeCode(e.code)};}
  }
  async function health(){
    const rows=[];
    for(let i=0;i<list.length;i+=4)rows.push(...await Promise.all(list.slice(i,i+4).map(c=>nodeHealth(nodes.get(c.id)))));
    for(const id of new Set(Object.values(registry).map(r=>r.node)))if(!nodes.has(id))rows.push({id,name:id,ready:false,acceptingNewJobs:false,removed:true,error:'compute_node_not_configured'});
    const selected=rows.find(n=>n.id===defaultNode),ready=rows.filter(n=>n.ready);
    return {...(selected||{ready:ready.length>0,acceptingNewJobs:rows.some(n=>n.acceptingNewJobs),limits:{},configuredLimits:{},capacity:{}}),
      ...(!rows.length?{error:'compute_not_configured'}:{}),defaultNode,nodes:rows,
      summary:{configured:list.length,ready:ready.length,accepting:rows.filter(n=>n.acceptingNewJobs).length,
        cpus:ready.reduce((s,n)=>s+(n.limits?.server_max_cpus||0),0),memory_gib:ready.reduce((s,n)=>s+(n.limits?.server_max_memory_gib||0),0),gpus:ready.reduce((s,n)=>s+(n.limits?.server_max_gpus||0),0)}};
  }
  const server=http.createServer(async(req,res)=>{
    let scope;for(const [workspace,token] of tokens)if(same(req.headers.authorization,'Bearer '+token))scope=workspace;
    if(!scope||req.headers.origin)return jsonResponse(res,401,{error:'project_capability_required'});
    const url=new URL(req.url,'http://project.invalid'),parts=url.pathname.split('/').filter(Boolean);
    try{
      if(req.method==='GET'&&url.pathname==='/health')return jsonResponse(res,200,await health());
      if(req.method==='GET'&&url.pathname==='/jobs')return jsonResponse(res,200,{jobs:Object.entries(registry).filter(([,v])=>v.workspace===scope).map(([id,v])=>view(id,v))});
      if(req.method==='POST'&&url.pathname==='/jobs'){
        const d=await bodyJson(req);const allowed=['files','entry','args','timeout','target','node','gpus','cpus','memory_gib','distributed','environment','backend','dependency_layer','data_ids','queue_timeout','setup_timeout','language'];
        if(!d||Array.isArray(d)||Object.keys(d).some(k=>!allowed.includes(k))||!d.files||Array.isArray(d.files)||Object.keys(d.files).length>1000||Object.keys(d.files).some(p=>!projectPath(p)))throw error('invalid_job_request');
        if(d.entry&&!projectPath(d.entry))throw error('invalid_entry');
        if(d.args&&(!Array.isArray(d.args)||d.args.some(a=>typeof a!=='string'||a.includes('\0'))))throw error('invalid_arguments');
        const node=d.node??defaultNode;
        if(!node)throw error('compute_node_required');
        if(!nodeId(node))throw error('invalid_compute_node');required(node);
        if(settings.nodes[node].paused)throw error('compute_node_admission_paused');
        const payload={...d};delete payload.node;
        const requestId=crypto.randomBytes(16).toString('hex');
        registry[requestId]={workspace:scope,node,outcomeUnknown:true,submittedAt:new Date().toISOString(),config:publicFields(d,configFields)};writePrivate(file,registry);
        const r=await upstream(node,'POST','/jobs',payload),v=await r.json();
        if(!r.ok){if(!String(v.error).includes('outcome_unknown'))delete registry[requestId];writePrivate(file,registry);return jsonResponse(res,r.status,{error:safeCode(v.error)});}
        if(!jobId(v.id))throw error('compute_invalid_job_response');
        const value={...publicJob(v),id:requestId,node};
        registry[requestId]={...registry[requestId],remoteId:v.id,outcomeUnknown:false,cached:value,checkedAt:new Date().toISOString()};writePrivate(file,registry);
        return jsonResponse(res,201,value);
      }
      if(parts[0]!=='jobs'||!jobId(parts[1])||registry[parts[1]]?.workspace!==scope)throw error('job_outside_project');
      const id=parts[1];
      if(registry[id].outcomeUnknown)throw error('compute_outcome_unknown_check_before_retry');
      const row=registry[id],remoteId=row.remoteId||id;
      if(!jobId(remoteId))throw error('invalid_remote_job_record');
      const route='/jobs/'+remoteId+(parts.length>2?'/'+parts.slice(2).join('/'):'');
      if(req.method==='POST'&&parts.length===3&&parts[2]==='cancel'){
        const r=await upstream(row.node,'POST',route,{}),v=await r.json();
        return jsonResponse(res,r.status,r.ok?{...publicJob(v),id,node:row.node}:{error:safeCode(v.error)});
      }
      if(req.method!=='GET')throw error('compute_route_not_allowed');
      if(parts.length===2||parts.length===3&&['logs','config'].includes(parts[2])){
        if([...url.searchParams.keys()].some(k=>!['cursor','after','limit'].includes(k)))throw error('invalid_query');
        const r=await upstream(row.node,'GET',route+url.search),v=await r.json();
        if(!r.ok)return jsonResponse(res,r.status,{error:safeCode(v.error)});
        const value=parts.length===2?{...publicJob(v),id,node:row.node}:parts[2]==='logs'?publicFields(v,['text','cursor','next_cursor','truncated','done','bytes']):publicFields(v,configFields);
        if(parts.length===2){registry[id].cached=value;registry[id].checkedAt=new Date().toISOString();writePrivate(file,registry);}
        if(parts[2]==='config'){registry[id].config=value;writePrivate(file,registry);}
        return jsonResponse(res,200,value);
      }
      if(parts[2]==='artifact'&&projectPath(decodeURIComponent(parts.slice(3).join('/')))){
        const r=await upstream(row.node,'GET',route);if(!r.ok)return jsonResponse(res,r.status,{error:'artifact_unavailable'});
        res.writeHead(200,{'content-type':'application/octet-stream','cache-control':'no-store'});
        for await(const chunk of r.body){if(!res.write(chunk))await new Promise(resolve=>res.once('drain',resolve));}return res.end();
      }
      throw error('compute_route_not_allowed');
    }catch(e){if(res.headersSent)res.destroy();else return jsonResponse(res,e.code==='job_outside_project'?403:503,{error:safeCode(e.code)});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
  return {port:server.address().port,health,capability(workspace){if(!tokens.has(workspace))tokens.set(workspace,crypto.randomBytes(32).toString('hex'));return tokens.get(workspace);},
    jobs:()=>Object.entries(registry).map(([id,v])=>view(id,v)),
    admission(id,paused){if(!nodes.has(id)||typeof paused!=='boolean')throw error('invalid_node_admission');settings.nodes[id].paused=paused;writePrivate(settingsFile,settings);return {id,paused};},
    close(){tokens.clear();server.closeAllConnections();server.close();}};
}
