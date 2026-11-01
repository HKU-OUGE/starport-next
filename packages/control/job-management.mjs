import { error } from '../runtime/common.mjs';
import { projectPath } from './compute.mjs';

// Management always goes through the same project capability checks as MCP.
export function createJobManagement(compute,{fetcher=fetch}={}) {
  let refreshing;
  const pending=new Set();
  const completeConfig=v=>['cpus','memory_gib','gpus'].every(k=>v?.[k]!==undefined);
  function owned(id) {
    const job=compute.jobs().find(j=>j.id===id);
    if(!job)throw error('job_not_found');
    if(job.outcomeUnknown)throw error('compute_outcome_unknown_check_before_retry');
    return job;
  }
  async function request(id,suffix='',body) {
    const job=owned(id);
    const r=await fetcher(`http://127.0.0.1:${compute.port}/jobs/${id}${suffix}`,{
      method:body===undefined?'GET':'POST',redirect:'error',
      headers:{authorization:'Bearer '+compute.capability(job.workspace),'content-type':'application/json'},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(45000)
    });
    if(!r.ok){const v=await r.json();throw error(/^[a-z][a-z0-9_]{1,79}$/.test(v.error)?v.error:'compute_unavailable');}
    return r;
  }
  async function detail(id) {
    const job=await(await request(id)).json();
    const cached=owned(id).config;
    const config=completeConfig(cached)?cached:await(await request(id,'/config')).json();
    return {...owned(id),...job,config};
  }
  async function refresh() {
    if(refreshing)return refreshing;
    refreshing=(async()=>{
      // Reconcile the oldest outstanding records first. Finished jobs are cached.
      const jobs=compute.jobs().filter(j=>!j.outcomeUnknown&&(!j.resources_released||!completeConfig(j.config)))
        .sort((a,b)=>(a.checkedAt||'').localeCompare(b.checkedAt||'')).slice(0,8);
      const failures=[];
      for(let i=0;i<jobs.length;i+=2){
        const results=await Promise.allSettled(jobs.slice(i,i+2).map(j=>detail(j.id)));
        results.forEach((r,k)=>{if(r.status==='rejected')failures.push({id:jobs[i+k].id,error:r.reason.code||'compute_unavailable'});});
      }
      return {jobs:compute.jobs(),failures,checkedAt:new Date().toISOString()};
    })();
    try{return await refreshing;}finally{refreshing=null;}
  }
  return {refresh,detail,
    async logs(id,cursor=0){
      if(!Number.isSafeInteger(cursor)||cursor<0)throw error('invalid_cursor');
      return (await request(id,'/logs?cursor='+cursor)).json();
    },
    async cancel(id){
      if(pending.has(id))throw error('job_operation_pending');
      const job=owned(id);if(job.resources_released)throw error('job_already_finished');
      pending.add(id);
      try{return await(await request(id,'/cancel',{})).json();}finally{pending.delete(id);}
    },
    async artifact(id,name){
      if(!projectPath(name))throw error('invalid_artifact_path');
      const job=await detail(id),artifact=job.artifacts?.find(a=>a.path===name);
      if(!job.resources_released||!artifact)throw error('artifact_unavailable');
      if(!Number.isSafeInteger(artifact.bytes)||artifact.bytes<0||artifact.sha256!==undefined&&!/^[a-f0-9]{64}$/.test(artifact.sha256))throw error('artifact_metadata_invalid');
      if(artifact.bytes>64*1024*1024)throw error('panel_artifact_too_large_use_compute_client');
      return {response:await request(id,'/artifact/'+name.split('/').map(encodeURIComponent).join('/')),artifact};
    }
  };
}
