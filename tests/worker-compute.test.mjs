import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {createWorkerComputeBridge,workerRequest} from '../packages/control/worker-compute.mjs';
import {createCompute} from '../packages/control/compute.mjs';

const limits={cpus:8,memory_gib:16,gpus:4,timeout:3600,parallel:4},token='example-bridge-token-'.repeat(3);
const payload={entry:'main.py',files:{'main.py':Buffer.from('print("ok")').toString('base64')},cpus:1,memory_gib:2,gpus:0,timeout:60};
const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
function temporary(t){const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-pi-bridge-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function fake(){
  const calls=[],jobs=new Map();let n=0;
  const factory=workspace=>({async call(op,args={}){
    calls.push({op,workspace,args});
    if(op==='health')return {ready:true,egress_ready:true,cpus:16,memory_gib:32,gpus:4};
    if(op==='workspace.create')return {id:(++n).toString(16).padStart(32,'0')};
    if(op==='upload.begin')return {id:'c'.repeat(32)};
    if(op==='upload.chunk')return {};
    if(op==='upload.finish'){const f=Buffer.from('print("ok")');return {sha256:sha(f),bytes:f.length};}
    if(op==='job.submit'){const id=(++n).toString(16).padStart(32,'0');const v={id,status:'completed',released:true,exit_code:0,workspace};jobs.set(id,v);return v;}
    if(op==='job.status')return jobs.get(args.job);
    if(op==='job.logs')return {text:'ok\n',cursor:3};
    if(op==='job.artifacts')return {artifacts:[{path:'out.txt',bytes:3}]};
    if(op==='artifact.read'){const b=Buffer.from('ok\n');return {data:b.toString('base64'),offset:0,bytes:3,total:3,version:'one',sha256:sha(b)};}
    if(op==='job.cancel')return {cancel_requested:true};
    throw Error('unexpected_rpc');
  }});
  return {factory,calls};
}
test('Worker bridge gives each job a fresh workspace, preserves artifact bytes and scopes Next project access',async t=>{
  const f=fake(),bridge=await createWorkerComputeBridge({state:temporary(t),token,binding:'test',remoteFactory:f.factory,limits});t.after(()=>bridge.close());
  const c=await createCompute({state:temporary(t),connection:{url:`http://127.0.0.1:${bridge.port}`,token}});t.after(()=>c.close());
  const request=(project,route,body)=>fetch(`http://127.0.0.1:${c.port}${route}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+c.capability(project)},body:body?JSON.stringify(body):undefined});
  const first=await(await request('one','/jobs',payload)).json();const second=await(await request('two','/jobs',payload)).json();
  assert.notEqual(first.id,second.id);assert.equal(first.workspace,undefined);
  const submitted=f.calls.filter(c=>c.op==='job.submit');assert.notEqual(submitted[0].workspace,submitted[1].workspace);
  assert.equal((await request('two',`/jobs/${first.id}`)).status,403);
  assert.equal((await request('two',`/jobs/${first.id}/cancel`,{})).status,403);
  assert.equal(await(await request('one',`/jobs/${first.id}/artifact/out.txt`)).text(),'ok\n');
  assert.equal((await(await request('one',`/jobs/${first.id}`)).json()).resources_released,true);
  assert.equal((await(await request('one',`/jobs/${first.id}/logs?cursor=0`)).json()).text,'ok\n');
  assert.equal((await fetch(`http://127.0.0.1:${bridge.port}/health`)).status,401);
  assert.equal((await request('one','/health')).status,200);
});
test('Worker requests reject management fields, path traversal, unsupported backends and resource escalation',()=>{
  for(const extra of [{entry:'../x'},{files:{'../x':'eA=='}},{cpus:9},{gpus:5},{timeout:99999},{backend:'host'},{node:'operator'},{language:'powershell'},{args:['x\0y']}])assert.throws(()=>workerRequest({...payload,...extra},limits));
  const r=workerRequest({...payload,args:["'; touch /bad; '"]},limits);assert.ok(r.command.includes("'\\''"));
});
test('lost submit acknowledgements persist at both layers and are never resubmitted',async t=>{
  const f=fake();let submitted=0;const factory=w=>({async call(op,a){if(op==='job.submit'){submitted++;throw Error('remote_outcome_unknown');}return f.factory(w).call(op,a);}});
  const dir=temporary(t),bridge=await createWorkerComputeBridge({state:dir,token,binding:'test',remoteFactory:factory,limits});
  const c=await createCompute({state:temporary(t),connection:{url:`http://127.0.0.1:${bridge.port}`,token}});t.after(()=>c.close());
  const response=await fetch(`http://127.0.0.1:${c.port}/jobs`,{method:'POST',headers:{authorization:'Bearer '+c.capability('one')},body:JSON.stringify(payload)});
  assert.match((await response.json()).error,/outcome_unknown/);assert.equal(c.jobs()[0].outcomeUnknown,true);bridge.close();
  const restarted=await createWorkerComputeBridge({state:dir,token,binding:'test',remoteFactory:factory,limits});t.after(()=>restarted.close());
  const retry=await fetch(`http://127.0.0.1:${restarted.port}/jobs`,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(payload)});
  assert.match((await retry.json()).error,/outcome_unknown/);assert.equal(submitted,1);
  await assert.rejects(createWorkerComputeBridge({state:dir,token,binding:'different',remoteFactory:factory,limits}),/connection_changed/);
});

test('null parallel removes the job count ceiling while policy ceilings and acknowledged rejection remain enforced',async t=>{
  const f=fake();let reject=false;
  const factory=w=>({async call(op,a){if(op==='job.submit'&&reject)throw Object.assign(Error('cpu_capacity'),{outcomeKnown:true});const v=await f.factory(w).call(op,a);if(op==='job.submit'||op==='job.status')return {...v,status:'running',released:false};return v;}});
  const policy={cpus:255,memory_gib:1600,gpus:8,timeout:3600,parallel:null};
  const b=await createWorkerComputeBridge({state:temporary(t),token,binding:'test',remoteFactory:factory,limits:policy});t.after(()=>b.close());
  const submit=()=>fetch(`http://127.0.0.1:${b.port}/jobs`,{method:'POST',headers:{authorization:'Bearer '+token},body:JSON.stringify(payload)});
  for(let i=0;i<5;i++)assert.equal((await submit()).status,201);
  const h=await b.health();assert.equal(h.max_parallel_server,null);assert.equal(h.configuredLimits.cpus,255);assert.equal(h.limits.server_max_cpus,16);
  reject=true;assert.equal((await(await submit()).json()).error,'cpu_capacity');reject=false;
  assert.equal((await submit()).status,201);
  assert.throws(()=>workerRequest({...payload,cpus:256},policy),/resource_limit/);
  assert.throws(()=>workerRequest({...payload,memory_gib:1601},policy),/resource_limit/);
  assert.throws(()=>workerRequest({...payload,gpus:9},policy),/resource_limit/);
});
