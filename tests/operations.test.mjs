import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import {createCompute} from '../packages/control/compute.mjs';
import {createJobManagement} from '../packages/control/job-management.mjs';
import {createServices} from '../packages/control/services.mjs';
import {startHostControl} from '../packages/control/server.mjs';
import {jobTimestamp,selectJobs} from '../packages/control/web/operations.js';
import {viewName} from '../packages/control/web/shell.js';

const id='b'.repeat(32),unknown='c'.repeat(32),bytes=Buffer.from('任务结果\n'),sha=crypto.createHash('sha256').update(bytes).digest('hex');
const temporary=()=>fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-ops-'));
test('task filters handle worker epoch seconds, ISO records and unknown outcomes without mixing states',()=>{
  const seconds=1793510000,iso=new Date((seconds+1)*1000).toISOString();
  assert.equal(jobTimestamp(seconds),seconds*1000);assert.equal(jobTimestamp(iso),(seconds+1)*1000);
  const rows=[{id:'old',workspace:'a',status:'completed',created_at:seconds,config:{entry:'train.py'}},{id:'new',workspace:'a',status:'running',created_at:iso},{id:'unknown',workspace:'b',outcomeUnknown:true,submittedAt:new Date((seconds+2)*1000).toISOString()}];
  assert.deepEqual(selectJobs(rows).map(j=>j.id),['unknown','new','old']);
  assert.deepEqual(selectJobs(rows,{filter:'active'}).map(j=>j.id),['new']);
  assert.deepEqual(selectJobs(rows,{project:'a',search:'TRAIN'}).map(j=>j.id),['old']);
  assert.deepEqual(selectJobs(rows,{filter:'unknown'}).map(j=>j.id),['unknown']);
  assert.equal(rows[0].id,'old');
  assert.deepEqual(selectJobs([{id:'a',node:'one'},{id:'b',node:'two'}],{node:'two'}).map(j=>j.id),['b']);
  assert.equal(viewName('#servers'),'servers');assert.equal(viewName('#remote'),'remote');assert.equal(viewName('#task-center'),'tasks');assert.equal(viewName('#invalid'),'overview');
});
async function upstream({manifestHash=true}={}){
  const calls=[],server=http.createServer(async(req,res)=>{
    calls.push(req.url);res.setHeader('content-type','application/json');
    if(req.url==='/health')return res.end(JSON.stringify({ready:true}));
    if(req.url==='/jobs')return res.end(JSON.stringify({id,status:'running'}));
    if(req.url.endsWith('/config'))return res.end(JSON.stringify({entry:'job.py',cpus:2,gpus:1,memory_gib:4,private_path:'operator-only'}));
    if(req.url.includes('/logs'))return res.end(JSON.stringify({text:'log\n',cursor:4,done:true,operator:'private'}));
    if(req.url.endsWith('/cancel')){await new Promise(r=>setTimeout(r,20));return res.end(JSON.stringify({id,cancel:{requested:true}}));}
    if(req.url.includes('/artifact/'))return res.end(bytes);
    res.end(JSON.stringify({id,status:'completed',resources_released:true,artifacts:[{path:'result.txt',bytes:bytes.length,...(manifestHash?{sha256:sha}:{})}]}));
  });await new Promise(r=>server.listen(0,'127.0.0.1',r));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,close(){server.closeAllConnections();server.close();}};
}
test('task management reconciles owned jobs, caches completed metadata, and refuses unknown submissions',async()=>{
  const state=temporary(),u=await upstream();let c;
  try{
    fs.writeFileSync(path.join(state,'compute-jobs.json'),JSON.stringify({[id]:{workspace:'main',cached:{id,status:'running'}},[unknown]:{workspace:'main',outcomeUnknown:true}}));
    c=await createCompute({state,connection:{url:u.url,token:'operator-token'}});const manager=createJobManagement(c);
    await assert.rejects(manager.cancel(unknown),/outcome_unknown/);await assert.rejects(manager.detail('d'.repeat(32)),/job_not_found/);assert.equal(u.calls.length,0);
    const r=await manager.refresh();assert.equal(r.failures.length,0);const row=r.jobs.find(j=>j.id===id);assert.equal(row.resources_released,true);assert.equal(row.config.cpus,2);assert.equal(row.config.private_path,undefined);assert.ok(row.checkedAt);
    const before=u.calls.length;await manager.refresh();assert.equal(u.calls.length,before);
    const log=await manager.logs(id,0);assert.equal(log.text,'log\n');assert.equal(log.operator,undefined);await assert.rejects(manager.logs(id,-1),/invalid_cursor/);
    await assert.rejects(manager.artifact(id,'../private'),/invalid_artifact/);await assert.rejects(manager.artifact(id,'not-listed'),/artifact_unavailable/);
    const download=await manager.artifact(id,'result.txt');assert.deepEqual(Buffer.from(await download.response.arrayBuffer()),bytes);assert.equal(download.artifact.sha256,sha);
    await assert.rejects(manager.cancel(id),/already_finished/);
  }finally{c?.close();u.close();fs.rmSync(state,{recursive:true,force:true});}
});
test('a pending cancellation cannot be replayed concurrently',async()=>{
  const state=temporary(),u=await upstream();let c;
  try{
    fs.writeFileSync(path.join(state,'compute-jobs.json'),JSON.stringify({[id]:{workspace:'main',cached:{id,status:'running'}}}));
    c=await createCompute({state,connection:{url:u.url,token:'operator-token'}});const manager=createJobManagement(c);
    const first=manager.cancel(id);await assert.rejects(manager.cancel(id),/job_operation_pending/);await first;
    assert.equal(u.calls.filter(p=>p.endsWith('/cancel')).length,1);
  }finally{c?.close();u.close();fs.rmSync(state,{recursive:true,force:true});}
});
test('panel task and startup mutations require authentication, Origin and CSRF',async()=>{
  const state=temporary(),u=await upstream({manifestHash:false}),actions=[];let panel;
  try{
    fs.writeFileSync(path.join(state,'compute-jobs.json'),JSON.stringify({[id]:{workspace:'main',cached:{id,status:'running'}}}));
    panel=await startHostControl(state,{port:0,compute:{url:u.url,token:'operator'},configurationFile:path.join(state,'host.json'),testServices:{platform:'win32',execute:async(_file,args)=>{
      actions.push(args);return {code:0,stdout:JSON.stringify({registered:true,enabled:true})};
    }}});
    assert.equal((await fetch(panel.url+'api/jobs/'+id)).status,403);
    const key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'))).key,origin=panel.url.slice(0,-1);
    const login=await fetch(panel.url+'api/login',{method:'POST',headers:{origin},body:JSON.stringify({key})});
    const cookie=login.headers.get('set-cookie').split(';')[0],headers={cookie,origin};
    for(const route of ['api/jobs/'+id+'/cancel','api/services/enable'])assert.equal((await fetch(panel.url+route,{method:'POST',headers,body:'{}'})).status,403);
    assert.equal(actions.length,0);assert.equal(u.calls.some(p=>p.endsWith('/cancel')),false);
    const status=await(await fetch(panel.url+'api/status',{headers})).json();headers['x-csrf-token']=status.csrf;
    assert.equal((await fetch(panel.url+'api/services/enable',{method:'POST',headers,body:'{}'})).status,200);
    assert.deepEqual(actions.map(a=>a[a.indexOf('-Action')+1]),['enable','start']);
    assert.ok(actions.every(a=>a[a.indexOf('-State')+1]===state));
    assert.equal((await fetch(panel.url+'api/jobs/'+id+'/cancel',{method:'POST',headers,body:'{}'})).status,200);
    const download=await fetch(panel.url+'api/jobs/'+id+'/artifact?path=result.txt',{headers});assert.equal(download.status,200);assert.equal(download.headers.get('x-content-sha256'),sha);assert.deepEqual(Buffer.from(await download.arrayBuffer()),bytes);
    assert.equal((await fetch(panel.url+'api/jobs/'+unknown+'/logs',{headers})).status,403);
    assert.equal((await fetch(panel.url+'api/services/arbitrary',{method:'POST',headers,body:'{}'})).status,403);
  }finally{await panel?.close();u.close();fs.rmSync(state,{recursive:true,force:true});}
});
test('stale supervisor receipts never report a running service; unsupported hosts cannot register',async()=>{
  const state=temporary();
  try{
    fs.writeFileSync(path.join(state,'services.json'),JSON.stringify({format:'starport-user-services-status',checkedAt:new Date(0).toISOString(),services:[{id:'control',phase:'running',pid:123,private:'operator'}]}));
    const manager=createServices(state,'synthetic.json',{platform:'win32',execute:async()=>({code:0,stdout:'{"registered":true,"enabled":true}'})});
    const s=await manager.status();assert.equal(s.supervisor.phase,'stopped');assert.equal(s.services[0].phase,'unknown');assert.equal(s.services[0].private,undefined);
    await assert.rejects(manager.action('delete'),/invalid_service_action/);
    await assert.rejects(createServices(state,'synthetic.json',{platform:'darwin'}).action('enable'),/local_windows_installation/);
  }finally{fs.rmSync(state,{recursive:true,force:true});}
});
