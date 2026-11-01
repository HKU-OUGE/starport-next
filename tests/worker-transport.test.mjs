import test from 'node:test';
import assert from 'node:assert/strict';
import {workerSshArgs,WorkerRemote} from '../packages/control/worker-transport.mjs';
import {cleanEnv,executable,run} from '../packages/runtime/common.mjs';

test('standalone worker transport pins host trust and exposes only fixed worker RPC',async()=>{
  const c={mode:'dsw',user:'operator',instanceId:'dsw-0123456789abcdef',region:'region-example',hostKeyAlias:'starport-example',identityFile:'private/key',knownHostsFile:'private/known-hosts',python:'python'};
  const args=workerSshArgs(c,'private/connection.json');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('ForwardAgent=no'));assert.ok(args.includes('IdentityAgent=none'));assert.ok(args.includes('ClearAllForwardings=yes'));assert.ok(args.includes('SendEnv=-*'));
  assert.ok(!args.join(' ').includes('starport-pi'));
  assert.throws(()=>workerSshArgs({...c,hostKeyAlias:'x\n-oBad'},'private/connection.json'));
  await assert.rejects(new WorkerRemote(c,'private/connection.json').call('shell.local',{command:'whoami'}),/unsupported_worker_operation/);
});
test('Windows OpenSSH can start with the restricted operator environment', {skip:process.platform!=='win32'},async()=>{
  assert.equal(cleanEnv().ProgramData,process.env.ProgramData);
  const r=await run(executable('ssh'),['-V']);assert.equal(r.code,0);assert.match(r.stderr,/OpenSSH/);
});
