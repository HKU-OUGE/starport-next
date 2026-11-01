import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCompute} from '../packages/control/compute.mjs';
import {controlNodes} from '../packages/control/compute-nodes.mjs';
const payload={entry:'main.py',files:{'main.py':'eA=='},cpus:1,memory_gib:2,gpus:0};
const remoteId='a'.repeat(32);
const nodes=[{id:'primary',name:'服务器 A',url:'http://127.0.0.1:20101',token:'token-a'},{id:'second',name:'服务器 B',url:'http://127.0.0.1:20102',token:'token-b'}];
function fixture(){
  const state=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-multi-')),calls=[];
  let unavailable=false,unknown=false;
  const fetcher=async(url,options)=>{
    const node=url.port==='20101'?'primary':'second';calls.push({node,route:url.pathname,method:options.method,body:options.body?JSON.parse(options.body):undefined});
    assert.equal(options.headers.authorization,'Bearer '+(node==='primary'?'token-a':'token-b'));
    if(unavailable&&node==='second'||unknown&&node==='primary'&&options.method==='POST')throw Error('operator-private-error');
    let value={id:remoteId,status:'running'};
    if(url.pathname==='/health')value={ready:true,accepting_new_jobs:true,limits:{server_max_cpus:node==='primary'?8:16,server_max_memory_gib:32,server_max_gpus:2},private_host:'secret-host'};
    if(url.pathname.endsWith('/logs'))value={text:node+' log',cursor:3};
    if(url.pathname.endsWith('/config'))value=payload;
    if(url.pathname.endsWith('/cancel'))value={id:remoteId,cancel:{requested:true}};
    if(url.pathname.includes('/artifact/'))return new Response(node+' artifact');
    return Response.json(value);
  };
  return {state,calls,fetcher,setUnavailable:()=>{unavailable=true;},setUnknown:()=>{unknown=true;},clean:()=>fs.rmSync(state,{recursive:true,force:true})};
}
const request=(c,project,route,body)=>fetch(`http://127.0.0.1:${c.port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+c.capability(project)},body:body===undefined?undefined:JSON.stringify(body)});
test('multiple servers require explicit selection and duplicate remote IDs remain separately owned',async()=>{
  const f=fixture();let c;
  try{c=await createCompute({...f,connections:nodes});
    const missing=await request(c,'one','/jobs',payload);assert.equal((await missing.json()).error,'compute_node_required');assert.equal(f.calls.length,0);
    const a=await(await request(c,'one','/jobs',{...payload,node:'primary'})).json(),b=await(await request(c,'one','/jobs',{...payload,node:'second'})).json();
    assert.notEqual(a.id,b.id);assert.notEqual(a.id,remoteId);assert.equal(a.node,'primary');assert.equal(b.node,'second');
    assert.ok(f.calls.every(v=>v.body.node===undefined));
    for(const job of [a,b]){
      const s=await(await request(c,'one','/jobs/'+job.id)).json();assert.equal(s.id,job.id);assert.equal(s.node,job.node);
      const log=await(await request(c,'one',`/jobs/${job.id}/logs`)).json();assert.equal(log.text,job.node+' log');
      assert.equal(await(await request(c,'one',`/jobs/${job.id}/artifact/result.txt`)).text(),job.node+' artifact');
      assert.equal((await request(c,'two',`/jobs/${job.id}/cancel`,{})).status,403);
      await request(c,'one',`/jobs/${job.id}/cancel`,{});assert.equal(f.calls.at(-1).node,job.node);assert.ok(f.calls.at(-1).route.includes(remoteId));
    }
    const ids=c.jobs().map(j=>j.id);c.close();c=await createCompute({...f,connections:[...nodes].reverse()});assert.deepEqual(c.jobs().map(j=>j.id),ids);
    assert.equal((await(await request(c,'one',`/jobs/${a.id}/logs`)).json()).text,'primary log');
  }finally{c?.close();f.clean();}
});
test('one offline server does not hide healthy nodes; pause blocks only new tasks and survives restart',async()=>{
  const f=fixture();let c;
  try{c=await createCompute({...f,connections:nodes,defaultNode:'primary'});const job=await(await request(c,'one','/jobs',payload)).json();
    c.admission('primary',true);assert.equal((await(await request(c,'one','/jobs',payload)).json()).error,'compute_node_admission_paused');
    assert.equal((await request(c,'one',`/jobs/${job.id}`)).status,200);c.close();
    c=await createCompute({...f,connections:nodes,defaultNode:'primary'});f.setUnavailable();const health=await c.health();
    assert.equal(health.nodes[0].paused,true);assert.equal(health.nodes[1].ready,false);assert.equal(health.summary.ready,1);assert.equal(health.summary.cpus,8);
    assert.ok(!JSON.stringify(health).includes('secret-host'));assert.ok(!JSON.stringify(health).includes('token-a'));
    c.admission('primary',false);assert.equal((await request(c,'one','/jobs',payload)).status,201);
  }finally{c?.close();f.clean();}
});
test('unknown submissions stay on the selected server without failover or mutation replay',async()=>{
  const f=fixture();let c;
  try{c=await createCompute({...f,connections:nodes});f.setUnknown();
    const r=await request(c,'one','/jobs',{...payload,node:'primary'});assert.match((await r.json()).error,/outcome_unknown/);
    assert.equal(f.calls.length,1);assert.equal(f.calls[0].node,'primary');assert.equal(c.jobs()[0].node,'primary');assert.equal(c.jobs()[0].outcomeUnknown,true);
    const id=c.jobs()[0].id;await request(c,'one',`/jobs/${id}/cancel`,{});assert.equal(f.calls.length,1);
  }finally{c?.close();f.clean();}
});
test('legacy history is pinned to primary; removed or changed endpoints cannot capture its jobs',async()=>{
  const f=fixture();let c;
  try{fs.writeFileSync(path.join(f.state,'compute-jobs.json'),JSON.stringify({[remoteId]:{workspace:'one',cached:{id:remoteId,status:'running'}}}));
    c=await createCompute({...f,connection:nodes[0]});assert.equal(c.jobs()[0].node,'primary');c.close();
    c=await createCompute({...f,connections:[nodes[1]]});const count=f.calls.length;
    assert.equal((await(await request(c,'one',`/jobs/${remoteId}`)).json()).error,'compute_node_not_configured');assert.equal(f.calls.length,count);c.close();
    c=await createCompute({...f,connections:[{...nodes[0],url:'http://127.0.0.1:20201'},nodes[1]]});
    assert.match((await(await request(c,'one',`/jobs/${remoteId}`)).json()).error,/connection_changed/);
    assert.equal(f.calls.length,count);
  }finally{c?.close();f.clean();}
});
test('compute configuration rejects ambiguous defaults, duplicate IDs and duplicate endpoints',async()=>{
  for(const c of [{compute:{},computeNodes:[]},{computeNodes:[{id:'a',url:'x'},{id:'a',url:'y'}]},{computeNodes:[{id:'a',url:'x'}],defaultComputeNode:'absent'}])assert.throws(()=>controlNodes(c));
  const f=fixture();try{await assert.rejects(createCompute({...f,connections:[nodes[0],{...nodes[0],id:'copy'}]}),/duplicate_compute_endpoint/);}finally{f.clean();}
});
