import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {EventEmitter} from 'node:events';
import {workspaceExplorerPath,openWorkspaceFolder} from '../packages/control/explorer.mjs';

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
