import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {snapshotControl,createConfigurationTransfer} from '../packages/control/config-transfer.mjs';
import {decodeBundle} from '../packages/config/portable.mjs';
import {loadProfile} from '../packages/config/store.mjs';
import {startHostControl} from '../packages/control/server.mjs';

const password='example-password-for-tests';
function fixture(t){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-transfer-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const write=(file,value)=>fs.writeFileSync(path.join(dir,file),typeof value==='string'?value:JSON.stringify(value),{mode:0o600});
  write('key','example-provider-token');write('ssh-key','-----BEGIN OPENSSH PRIVATE KEY-----example');
  write('credentials','accesskeyid=example-access-id\naccesskeysecret=example-access-secret\nregionid=example-region\n');
  write('nodes.json',{nodes:[{name:'node',type:'trojan',server:'proxy.example.com',port:443,password:'example-node-password'}]});
  write('connection.json',{mode:'dsw',instanceId:'dsw-0123456789abcdef',region:'cn-example',user:'operator',identityFile:'ssh-key',credentialsFile:'credentials',knownHostsFile:'not-exported',proxyClient:'not-exported'});
  write('worker.json',{format:'starport-worker-compute',version:1,connectionFile:'connection.json',limits:{cpus:255,memory_gib:1600,gpus:8,timeout:3600,parallel:null}});
  write('control.json',{format:'starport-host-control',version:1,model:'example-model',nodesFile:'nodes.json',apiKeyFile:'key',workerComputeFile:'worker.json',wslg:true});
  return {dir,file:path.join(dir,'control.json')};
}

test('multi-server encrypted export keeps separate connections, policies, names and default selection',async t=>{
  const {dir,file}=fixture(t),host=JSON.parse(fs.readFileSync(file));delete host.workerComputeFile;
  const worker=JSON.parse(fs.readFileSync(path.join(dir,'worker.json')));worker.limits={cpus:133,memory_gib:1016,gpus:0,timeout:3600,parallel:null};
  fs.writeFileSync(path.join(dir,'cpu-worker.json'),JSON.stringify(worker));
  host.computeNodes=[{id:'primary',name:'GPU server',url:'http://127.0.0.1:19091',tokenFile:'key',workerComputeFile:'worker.json'},
    {id:'cpu-1',name:'CPU server',url:'http://127.0.0.1:19092',tokenFile:'key',workerComputeFile:'cpu-worker.json'}];host.defaultComputeNode='cpu-1';
  fs.writeFileSync(file,JSON.stringify(host));
  const transfer=createConfigurationTransfer(path.join(dir,'state'),file),exported=await transfer.handle('export',{source:'current',includeSecrets:true,password});
  const decoded=await decodeBundle(exported.bundle,password);
  assert.equal(decoded.config.defaultComputeNode,'cpu-1');assert.equal(decoded.config.nodes[1].name,'CPU server');assert.equal(decoded.config.computePolicies['cpu-1'].gpus,0);assert.equal(decoded.config.computePolicies.primary.gpus,8);
  assert.ok(decoded.privateValues['secret://compute-primary']);assert.ok(decoded.privateValues['secret://compute-cpu-1']);
  const template=snapshotControl(file).value;assert.deepEqual(template.privateValues,{});assert.equal(template.config.nodes.length,2);
  const p=await transfer.handle('preview',{bundle:exported.bundle,password});assert.equal(p.computePolicies['cpu-1'].parallel,null);assert.equal(p.defaultComputeNode,'cpu-1');
});

test('current installation template omits private identities; encrypted backup preserves intent and referenced secrets',async t=>{
  const {file}=fixture(t),plain=snapshotControl(file).value;
  assert.deepEqual(plain.privateValues,{});assert.equal(plain.config.computePolicy.parallel,null);assert.equal(plain.config.workspace.wslg,true);
  for(const text of ['example-provider-token','dsw-0123456789abcdef','proxy.example.com','not-exported','example-access-secret'])assert.ok(!JSON.stringify(plain).includes(text));
  const state=path.join(path.dirname(file),'state'),transfer=createConfigurationTransfer(state,file);
  const exported=await transfer.handle('export',{source:'current',includeSecrets:true,password});
  assert.equal(exported.encrypted,true);assert.ok(!JSON.stringify(exported).includes('example-access-secret'));
  const decoded=await decodeBundle(exported.bundle,password);
  assert.equal(decoded.privateValues['secret://compute-connection'].credentials.accessKeySecret,'example-access-secret');
  assert.equal(decoded.privateValues['secret://network-subscription'].nodes[0].password,'example-node-password');
  assert.ok(!JSON.stringify(decoded).includes('not-exported'));
  await assert.rejects(decodeBundle(exported.bundle,'wrong-test-password'),/password_or_integrity/);
});

test('preview-bound import is additive, encrypted and unverified; duplicate names and changed bundles are rejected',async t=>{
  const {dir,file}=fixture(t),transfer=createConfigurationTransfer(path.join(dir,'state'),file);
  const exported=await transfer.handle('export',{source:'current',includeSecrets:true,password});
  await assert.rejects(transfer.handle('import',{name:'imported',bundle:exported.bundle,password}),/preview_required/);
  const p=await transfer.handle('preview',{bundle:exported.bundle,password});
  assert.ok(!JSON.stringify(p).includes('example-access-secret'));
  await assert.rejects(transfer.handle('import',{name:'imported',bundle:{...exported.bundle,tag:'changed'},password,previewToken:p.previewToken}),/preview_required/);
  const r=await transfer.handle('import',{name:'imported',bundle:exported.bundle,password,previewToken:p.previewToken});
  assert.equal(r.activated,false);assert.equal(r.startedServices,false);
  const root=path.join(dir,'state/imported-profiles/imported');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root,'verification.json'))).state,'unverified');
  assert.equal((await loadProfile(root,password,{unlock:true})).config.computePolicy.parallel,null);
  const again=await transfer.handle('preview',{bundle:exported.bundle,password});
  await assert.rejects(transfer.handle('import',{name:'imported',bundle:exported.bundle,password,previewToken:again.previewToken}),/destination_exists/);
  for(const name of ['../outside','current','a/b'])await assert.rejects(transfer.handle('import',{name,bundle:exported.bundle,password,previewToken:again.previewToken}),/invalid_profile_name/);
  assert.equal((await transfer.list()).profiles.length,1);
});

test('exporting imported profiles cannot read arbitrary paths and reuses the stored vault',async t=>{
  const {dir,file}=fixture(t),transfer=createConfigurationTransfer(path.join(dir,'state'),file);
  const value=snapshotControl(file).value,p=await transfer.handle('preview',{bundle:value});
  await transfer.handle('import',{name:'copy',bundle:value,previewToken:p.previewToken});
  const exported=await transfer.handle('export',{source:'copy',includeSecrets:false});
  assert.deepEqual(exported.bundle.config,value.config);
  await assert.rejects(transfer.handle('export',{source:'../../private',includeSecrets:false}),/invalid_profile_name/);
});

test('configuration endpoints require the local panel session, Origin and CSRF',async t=>{
  const {dir,file}=fixture(t),state=path.join(dir,'control-state');
  const server=await startHostControl(state,{port:0,configurationFile:file,testEgress:{proxyPort:9,apiPort:9,enabled:true,close(){},pause(){},resume(){}},testLaunch:()=>{throw Error('must_not_launch');}});
  try{
  assert.equal((await fetch(server.url+'api/configuration')).status,403);
  const key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'))).key,origin=server.url.slice(0,-1),headers={origin,'content-type':'application/json'};
  const login=await fetch(server.url+'api/login',{method:'POST',headers,body:JSON.stringify({key})});headers.cookie=login.headers.get('set-cookie').split(';')[0];
  assert.equal((await fetch(server.url+'api/configuration/export',{method:'POST',headers,body:JSON.stringify({source:'current',includeSecrets:false})})).status,403);
  const status=await(await fetch(server.url+'api/status',{headers})).json();headers['x-csrf-token']=status.csrf;
  const r=await fetch(server.url+'api/configuration/export',{method:'POST',headers,body:JSON.stringify({source:'current',includeSecrets:false})});
  assert.equal(r.status,200);assert.equal((await r.json()).encrypted,false);
  assert.equal((await fetch(server.url+'api/configuration/export',{method:'POST',headers:{...headers,origin:'https://other.example.com'},body:'{}'})).status,403);
  }finally{server.close();}
});
