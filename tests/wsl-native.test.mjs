import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {createWslRuntime} from '../packages/wsl/runtime.mjs';

test('WSLg requires explicit opt-in before any project process is launched',async()=>{
  let launches=0;
  const runtime=createWslRuntime('unused',{launch:()=>{launches++;},destinations:{},capabilities:()=>({})});
  await assert.rejects(runtime.nativeAction('main','browser'),/wslg_authorization_required/);
  assert.equal(launches,0);runtime.close();
});

test('SDK and command operations share one workspace execution lease',async()=>{
  let launches=0;
  const launch=()=>{
    launches++;const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin.on('finish',()=>child.emit('close',0));return child;
  };
  const runtime=createWslRuntime('unused',{launch,destinations:{},capabilities:()=>({})});
  const command=runtime.execute('main',{operation:'exec',argv:['true']},{timeout:null});
  const completed=assert.rejects(command,/workspace_control_disconnected/);
  assert.throws(()=>runtime.execute('main',{operation:'sdk',request:{prompt:'test'}}),/workspace_busy/);
  assert.equal(launches,1);runtime.close();await completed;
});

for(const display of ['wslg','remote'])test(`${display} apps reuse one namespace, reject live display switching and never receive the SDK capability`,async()=>{
  const frames=[],capabilities={modelCapability:'sdk-only-example',computeCapability:'project-example'};let launches=0;
  const launch=()=>{
    launches++;
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('close',0);
    child.stdin.on('data',data=>{for(const line of data.toString().trim().split('\n')){
      const value=JSON.parse(line);frames.push(value);
      if(value.workspace)setImmediate(()=>child.stdout.write(JSON.stringify({type:'output',stream:'stdout',data:Buffer.from('{"kind":"native_ready"}\n').toString('base64')})+'\n'));
    }});
    child.stdin.on('finish',()=>child.emit('close',0));return child;
  };
  const runtime=createWslRuntime('unused',{launch,wslg:true,destinations:{},capabilities:()=>capabilities});
  await runtime.nativeAction('main','browser',display);await runtime.nativeAction('main','desktop',display);
  assert.equal(launches,1);assert.equal(frames[0].request.wslg,display==='wslg');
  assert.equal(frames[0].request.display,display);
  await assert.rejects(runtime.nativeAction('main','browser',display==='wslg'?'remote':'wslg'),/close_existing_display_first/);
  assert.equal(launches,1);
  assert.equal(frames[0].request.modelCapability,undefined);
  assert.equal(capabilities.modelCapability,'sdk-only-example');
  assert.deepEqual(frames.slice(1).map(v=>v.app),['browser','desktop']);
  await assert.rejects(runtime.nativeAction('main','arbitrary-command'),/invalid_native_app/);
  await runtime.stopNative('main');runtime.close();
});
