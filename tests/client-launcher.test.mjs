import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {launchLocalClient} from '../packages/control/client-launcher.mjs';

async function fixture(t,{remote=false,verified=true,verificationPass=true,earlyExit=false}={}){
  const state=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-launch-')),key='a'.repeat(64),calls=[];
  const status={workspaces:['main'],csrf:'test-csrf',egress:{enabled:true},runtime:{wslg:true,active:[],reports:verified?[{workspace:'main',passed:true}]:[],native:remote?[{workspace:'main',phase:'running',display:'remote',apps:{desktop:'running'}}]:[]}};
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;body=body?JSON.parse(body):undefined;
    calls.push({route:req.url,body});res.setHeader('content-type','application/json');
    assert.equal(req.headers.origin,'http://127.0.0.1:'+server.address().port);
    if(req.url==='/api/login'){assert.equal(body.key,key);res.setHeader('set-cookie','starport_control='+'b'.repeat(64)+'; HttpOnly; Path=/');return res.end('{}');}
    assert.equal(req.headers.cookie,'starport_control='+'b'.repeat(64));
    if(req.method==='POST')assert.equal(req.headers['x-csrf-token'],'test-csrf');
    if(req.url.endsWith('/verify'))return res.end(JSON.stringify({passed:verificationPass}));
    if(req.url.endsWith('/native')){assert.deepEqual(body,{app:'browser',display:'wslg'});status.runtime.native=[{workspace:'main',phase:'running',display:'wslg',apps:{browser:'running'}}];return res.end('{"phase":"running"}');}
    res.end(JSON.stringify(status));
    if(earlyExit&&status.runtime.native[0]?.apps?.browser==='running')status.runtime.native[0].apps.browser='stopped';
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  fs.writeFileSync(path.join(state,'control.json'),JSON.stringify({phase:'running',port:server.address().port,url:'https://untrusted.example.com/'}));
  fs.writeFileSync(path.join(state,'panel-key.json'),JSON.stringify({key}));
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(state,{recursive:true,force:true});});
  return {state,calls};
}
test('desktop launcher authenticates only to loopback and requests the scoped WSLg client',async t=>{
  const {state,calls}=await fixture(t),result=await launchLocalClient({state,app:'browser'});
  assert.deepEqual(result,{workspace:'main',app:'browser',display:'wslg',phase:'running'});
  assert.equal(calls.filter(v=>v.route.endsWith('/native')).length,1);
  assert.equal(calls.some(v=>v.route.endsWith('/verify')),false);
  assert.equal(JSON.stringify(result).includes('a'.repeat(64)),false);
});
test('remote GUI sessions are preserved instead of stopped or silently switched',async t=>{
  const {state,calls}=await fixture(t,{remote:true});
  await assert.rejects(launchLocalClient({state,app:'browser'}),/close_existing_display_first/);
  assert.equal(calls.some(v=>v.route.endsWith('/native')||v.route.endsWith('/verify')),false);
});
test('missing verification runs boundary checks and cannot launch after a failed check',async t=>{
  const {state,calls}=await fixture(t,{verified:false,verificationPass:false});
  await assert.rejects(launchLocalClient({state,app:'browser'}),/workspace_verification_failed/);
  assert.equal(calls.at(-1).route,'/api/workspaces/main/verify');
  assert.equal(calls.some(v=>v.route.endsWith('/native')),false);
});
test('launcher rejects arbitrary commands and workspace paths before reading credentials',async()=>{
  await assert.rejects(launchLocalClient({state:'missing',app:'bash'}),/invalid_native_app/);
  await assert.rejects(launchLocalClient({state:'missing',app:'browser',workspace:'../root'}),/invalid_workspace/);
});
test('an application that exits after acknowledgement is not reported as launched',async t=>{
  const {state}=await fixture(t,{earlyExit:true});
  await assert.rejects(launchLocalClient({state,app:'browser'}),/native_app_stopped/);
});
