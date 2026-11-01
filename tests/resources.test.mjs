import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createCompute} from '../packages/control/compute.mjs';
import {createWorkerComputeBridge,workerRequest} from '../packages/control/worker-compute.mjs';
import {startHostControl} from '../packages/control/server.mjs';

const id='a'.repeat(32),version='b'.repeat(64),token='example-resource-token-'.repeat(3);
const row={id,version,kind:'python',name:'Python fixture',phase:'ready',python_entry:'bin/python',source:'/private-source',publisher_pid:123};
const limits={cpus:2,memory_gib:4,gpus:0,timeout:120,parallel:null};
function temp(t){const d=fs.mkdtempSync(path.join(os.tmpdir(),'starport-resource-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('resource catalog strips private fields, stays node-scoped and refuses project management',async t=>{
  const calls=[],remoteFactory=()=>({async call(op,input){calls.push([op,input]);if(op==='resource.list')return {resources:[row,{...row,id:'c'.repeat(32),phase:'disabled'}]};if(op==='health')return {ready:true,egress_ready:true,cpus:2,memory_gib:4,gpus:0};if(op==='resource.register')return {...row,...input,phase:'publishing'};throw Error('unexpected_rpc');}});
  const bridge=await createWorkerComputeBridge({state:temp(t),token,binding:'one',remoteFactory,limits});t.after(()=>bridge.close());
  const connections=[{id:'primary',url:`http://127.0.0.1:${bridge.port}`,token}];
  const control=await createCompute({state:temp(t),connections,defaultNode:'primary'});t.after(()=>control.close());
  const request=(route,body)=>fetch(`http://127.0.0.1:${control.port}${route}`,{method:body?'POST':'GET',headers:{authorization:'Bearer '+control.capability('main')},body:body?JSON.stringify(body):undefined});
  const catalog=await(await request('/resources?node=primary')).json();
  assert.equal(catalog.resources.length,1);assert.equal(catalog.node,'primary');assert.equal(catalog.resources[0].path,'/dependencies/'+id);
  assert.ok(!JSON.stringify(catalog).includes('private-source'));assert.equal(catalog.resources[0].publisher_pid,undefined);
  assert.equal((await request('/resources',{source:'/private'})).status,403);
  assert.equal((await request('/resources/'+id+'/disable',{})).status,403);
  assert.equal((await request('/resources/auto-conda',{})).status,403);
  assert.match((await(await request('/resources?node=absent')).json()).error,/not_configured/);
  assert.equal(calls.some(([op])=>op==='resource.register'),false);
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'starport-resource-control-')),s=await startHostControl(state,{port:0,computeNodes:connections,defaultComputeNode:'primary'});t.after(async()=>{await s.close();fs.rmSync(state,{recursive:true,force:true});});
  assert.equal((await fetch(s.url+'api/resources')).status,403);
  const key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'),'utf8')).key;
  const headers={origin:s.url.slice(0,-1),'content-type':'application/json'};
  const login=await fetch(s.url+'api/login',{method:'POST',headers,body:JSON.stringify({key})});headers.cookie=login.headers.get('set-cookie').split(';')[0];
  headers['x-csrf-token']=(await(await fetch(s.url+'api/status',{headers})).json()).csrf;
  const input={node:'primary',id,name:'Empty fixture',kind:'data',source:'/fixture/empty'};
  const post=(body,h=headers)=>fetch(s.url+'api/resources',{method:'POST',headers:h,body:JSON.stringify(body)});
  assert.equal((await post(input)).status,403);
  assert.equal((await post({...input,reviewed:true},{...headers,'x-csrf-token':'wrong'})).status,403);
  assert.equal(calls.some(([op])=>op==='resource.register'),false);
  const result=await(await post({...input,reviewed:true})).json();assert.equal(result.phase,'publishing');assert.equal(result.source,undefined);
  assert.equal(calls.filter(([op])=>op==='resource.register').length,1);
});

test('only pinned catalog entries can select the sandbox Python interpreter',()=>{
  const base={entry:'main.py',files:{'main.py':'cGFzcw=='},mounts:[{id,version}],python_environment:id};
  const request=workerRequest(base,limits,[row]);assert.ok(request.command.startsWith("'/dependencies/"+id+"/bin/python'"));
  assert.deepEqual(request.mounts,[{id,version}]);
  for(const [input,catalog] of [[{...base,mounts:[{id,version:'c'.repeat(64)}]},[row]],[base,[{...row,phase:'disabled'}]],[base,[{...row,kind:'data'}]],[base,[{...row,python_entry:'../../host/python'}]],[{...base,mounts:[{id,version,source:'/host'}]},[row]],[{...base,mounts:[{id,version},{id,version}]},[row]]])assert.throws(()=>workerRequest(input,limits,catalog));
});
