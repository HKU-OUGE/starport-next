import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {createRemoteSettings,remoteInput} from '../packages/control/remote-settings.mjs';
import {startHostControl} from '../packages/control/server.mjs';

const input={enabled:true,hostname:'Panel.Example.com',issuer:'https://example.cloudflareaccess.com/',audience:'example-audience',allowedEmails:[' Operator@example.com ','operator@example.com'],tunnelEnabled:false};
function fixture(t){
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-remote-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'host.json');fs.writeFileSync(file,JSON.stringify({format:'starport-host-control',version:1,port:18884,model:'example-preserved-model',wslg:true}),{mode:0o600});
  return {dir,file};
}
test('remote settings normalize exact emails and reject malformed origins, wildcards and tokens',()=>{
  const value=remoteInput(input);assert.equal(value.access.hostname,'panel.example.com');assert.deepEqual(value.access.allowedEmails,['operator@example.com']);
  for(const change of [{hostname:'https://panel.example.com'},{hostname:'127.0.0.1'},{hostname:'panel.example.com/path'},{issuer:'https://example.com'},{issuer:'https://example.cloudflareaccess.com.evil.example.com'},{allowedEmails:['*@example.com']},{audience:'a\nb'},{tunnelToken:'too-short'},{tunnelToken:'x'.repeat(32)+'\n'},{unexpected:true}])assert.throws(()=>remoteInput({...input,...change}));
});
test('remote settings preserve unrelated configuration, hide tokens, enforce revisions and roll back failed activation',async t=>{
  const {dir,file}=fixture(t),applied=[];let fail=false;
  const settings=createRemoteSettings(file,{activate:async value=>{if(fail)throw Error('test_activation_failed');applied.push(value);}});
  const revision=settings.snapshot().revision,token='example-tunnel-token-'.repeat(4);
  const result=await settings.save({...input,revision,tunnelEnabled:true,tunnelToken:token});
  assert.equal(result.tokenPresent,true);assert.equal(result.publicAccessVerified,false);assert.ok(!JSON.stringify(result).includes(token));
  const config=JSON.parse(fs.readFileSync(file));assert.equal(config.model,'example-preserved-model');assert.equal(config.wslg,true);assert.equal(fs.readFileSync(path.join(dir,config.tunnel.tokenFile),'utf8'),token);
  await assert.rejects(settings.save({...input,revision}),/changed_reload/);
  await settings.save({...input,revision:result.revision,tunnelEnabled:true,tunnelToken:''});assert.equal(JSON.parse(fs.readFileSync(file)).tunnel.tokenFile,config.tunnel.tokenFile);
  const before=fs.readFileSync(file),tokenFiles=fs.readdirSync(path.join(dir,'.starport-remote')).filter(n=>n.startsWith('token-'));
  fail=true;await assert.rejects(settings.save({...input,revision:settings.snapshot().revision,tunnelEnabled:true,tunnelToken:'new-example-token-'.repeat(4)}),/activation_failed/);
  assert.deepEqual(fs.readFileSync(file),before);assert.deepEqual(fs.readdirSync(path.join(dir,'.starport-remote')).filter(n=>n.startsWith('token-')),tokenFiles);
  fail=false;await settings.save({enabled:false,revision:settings.snapshot().revision});assert.equal(settings.snapshot().enabled,false);assert.equal(JSON.parse(fs.readFileSync(file)).tunnel,undefined);assert.equal(applied.length,3);
});
test('remote settings apply live with local authentication and CSRF; remote cookies cannot bypass Access',async t=>{
  let panel;t.after(()=>panel?.close());
  const {dir,file}=fixture(t),state=path.join(dir,'state');
  panel=await startHostControl(state,{port:0,configurationFile:file});
  const origin=panel.url.slice(0,-1),key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'))).key;
  const login=await fetch(panel.url+'api/login',{method:'POST',headers:{origin},body:JSON.stringify({key})}),headers={origin,cookie:login.headers.get('set-cookie').split(';')[0]};
  assert.equal((await fetch(panel.url+'api/remote-access')).status,403);
  const initial=await(await fetch(panel.url+'api/remote-access',{headers})).json();
  const save=()=>fetch(panel.url+'api/remote-access',{method:'POST',headers,body:JSON.stringify({...input,revision:initial.revision})});
  assert.equal((await save()).status,403);assert.equal(JSON.parse(fs.readFileSync(file)).access,undefined);
  headers['x-csrf-token']=(await(await fetch(panel.url+'api/status',{headers})).json()).csrf;
  headers.origin='https://other.example.com';assert.equal((await save()).status,403);headers.origin=origin;
  const saved=await(await save()).json();assert.equal(saved.active.enabled,true);assert.equal(saved.active.hostname,'panel.example.com');
  const remote={...headers,host:'panel.example.com',origin:'https://panel.example.com'};
  const remoteStatus=route=>new Promise((resolve,reject)=>{http.get(panel.url+route,{headers:remote},res=>{res.resume();resolve(res.statusCode);}).on('error',reject);});
  assert.equal(await remoteStatus('api/status'),403);
  assert.equal(await remoteStatus('api/remote-access'),403);
  const check=await(await fetch(panel.url+'api/remote-access/check',{method:'POST',headers,body:'{}'})).json();assert.equal(check.originRejectsUnauthenticated,true);assert.equal(check.publicAccessVerified,false);
  assert.equal((await fetch(panel.url+'api/remote-access',{method:'POST',headers,body:JSON.stringify({enabled:false,revision:saved.revision})})).status,200);
  assert.equal((await fetch(panel.url+'api/status',{headers})).status,200);
  assert.equal(await remoteStatus('api/status'),403);
});
