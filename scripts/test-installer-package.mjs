#!/usr/bin/env node
// Real package lifecycle; no workspace, cloud resource or privileged operation.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import assert from 'node:assert/strict';
import {createInstaller} from '../packages/installer/installation.mjs';
import {panelClient} from '../packages/installer/driver.mjs';
import {defaultFeatures} from '../packages/installer/plan.mjs';
import {payload} from '../packages/installer/owned-files.mjs';
import {copyManager} from '../packages/installer/manager-copy.mjs';

const args=process.argv.slice(2);
assert.equal(args.length,2);assert.equal(args[0],'--source');
const source=path.resolve(args[1]);await payload(source);
const base=fs.mkdtempSync(path.join(os.tmpdir(),'starport-package-test-'));
const root=path.join(base,'Install space 中文');
const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));
const port=probe.address().port;await new Promise(r=>probe.close(r));
const plan={port,features:Object.fromEntries(Object.keys(defaultFeatures).map(k=>[k,false]))};
const manager=createInstaller({source,root});let copy;
try{
  console.log('package: install');await manager.apply(plan);assert.equal(manager.snapshot().installed,true);
  const first=await panelClient(root);assert.ok(first);assert.equal(first.status.runtime.active.length,0);
  const data=path.join(root,'private','keep-this-project.txt');fs.writeFileSync(data,'preserve project data\n');
  const id=manager.snapshot().installationId;
  console.log('package: repair');await manager.apply(plan);assert.equal(manager.snapshot().installationId,id);
  assert.equal(fs.readFileSync(data,'utf8'),'preserve project data\n');assert.ok(await panelClient(root));
  // The installed manager must be executable from a copy before removing its Node runtime.
  copy=await copyManager(root);await payload(copy.dir);
  console.log('package: preserve-data uninstall');await manager.uninstall({confirmId:id,deleteData:false});
  assert.equal(fs.existsSync(path.join(root,'runtime')),false);
  assert.equal(fs.readFileSync(data,'utf8'),'preserve project data\n');
  await manager.apply(plan);assert.equal(manager.snapshot().installed,true);
  assert.equal(fs.readFileSync(data,'utf8'),'preserve project data\n');
  await manager.uninstall({confirmId:id,deleteData:true});
  assert.equal(fs.existsSync(path.join(root,'private')),false);
  assert.equal(fs.existsSync(path.join(root,'app')),false);
  console.log(JSON.stringify({platform:process.platform,packageLifecycle:'passed',install:true,repair:true,preserveData:true,reinstall:true,removeOwnedData:true,administratorRequired:false}));
}catch(e){
  console.error(JSON.stringify({packageLifecycle:'failed',code:e.code||e.message}));
  // Private diagnostic logs stay in the runner's temporary test directory.
  const log=path.join(root,'private/setup/install.log');
  if(fs.existsSync(log))console.error(fs.readFileSync(log,'utf8').slice(-8000));
  try{if(manager.snapshot().existing)await manager.uninstall({confirmId:manager.snapshot().installationId,deleteData:true});}catch{}
  process.exitCode=1;
}finally{
  if(copy)fs.rmSync(copy.dir,{recursive:true,force:true});
  if(!process.exitCode)fs.rmSync(base,{recursive:true,force:true});
}
