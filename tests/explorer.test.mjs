import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {workspaceExplorerPath,openWorkspaceFolder} from '../packages/control/explorer.mjs';
import {workspaceAccess} from '../packages/control/web/workspace-access.js';

test('remote folder entry returns only a credential-free local panel link bound to a registered project',()=>{
  const status={control:{platform:'win32',remote:'cloudflare',port:18884},workspaces:['main','other']};
  const access=workspaceAccess(status,'other'),url=new URL(access.localUrl);
  assert.equal(access.canOpen,false);assert.equal(url.origin,'http://127.0.0.1:18884');
  assert.deepEqual([...url.searchParams],[['workspace','other']]);assert.equal(url.hash,'#workspaces');
  assert.equal(workspaceAccess(status,'../secret').localUrl,null);
  assert.equal(workspaceAccess(status,'unknown').localUrl,null);
  assert.equal(workspaceAccess({...status,control:{...status.control,remote:'local'}},'other').canOpen,true);
  assert.equal(workspaceAccess({...status,control:{...status.control,platform:'linux'}},'other').localUrl,null);
});

test('Explorer opens only an owned project UNC path without a shell or arbitrary caller path',async t=>{
  const receipt={phase:'installed',distribution:'StarportWork-0123456789abcdef'};
  const folder=workspaceExplorerPath(receipt,'main');assert.equal(folder,'\\\\wsl.localhost\\StarportWork-0123456789abcdef\\var\\lib\\starport-workspaces\\main\\project');
  for(const name of ['../secret','/root','a\\b','x, /select,C:'])assert.throws(()=>workspaceExplorerPath(receipt,name));
  assert.throws(()=>workspaceExplorerPath({...receipt,distribution:'Ubuntu'},'main'));
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'starport-explorer-'));t.after(()=>fs.rmSync(state,{recursive:true,force:true}));fs.writeFileSync(path.join(state,'wsl.json'),JSON.stringify(receipt));
  let launched;const launch=(file,args,options)=>{launched={file,args,options};const child=new EventEmitter();child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;};
  assert.equal((await openWorkspaceFolder(state,'main',{platform:'win32',windowsRoot:'C:\\Windows',launch})).opened,true);
  assert.equal(launched.file,'C:\\Windows\\explorer.exe');assert.deepEqual(launched.args,[folder]);assert.equal(launched.options.shell,false);
  await assert.rejects(openWorkspaceFolder(state,'main',{platform:'linux',launch}),/local_windows_action_required/);
});
