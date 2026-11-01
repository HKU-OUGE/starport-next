import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { generateKeyPair,exportJWK,createLocalJWKSet,SignJWT } from 'jose';
import { createCompute } from '../packages/control/compute.mjs';
import { createAccess,verifyAccess } from '../packages/control/access.mjs';
import { startHostControl } from '../packages/control/server.mjs';
import { pipeBridge } from '../packages/control/pipe-bridge.mjs';
import { loadControlOptions } from '../packages/control/config.mjs';
import { wslArgs } from '../packages/wsl/runtime.mjs';
import { startTunnel,tunnelArgs } from '../packages/control/tunnel.mjs';
import { computeSshArgs } from '../packages/control/ssh-tunnel.mjs';

function temp(t){const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-control-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
function child(){const p=new EventEmitter();p.stdin=new PassThrough();p.stdout=new PassThrough();p.stderr=new PassThrough();return p;}
const listen=s=>new Promise(r=>s.listen(0,'127.0.0.1',()=>r(s.address().port)));
test('WSL launcher accepts only owned distributions and does not use Windows shell interop',()=>{
  const args=wslArgs('StarportWork-0123456789abcdef','/usr/bin/python3','-I','/opt/starport-wsl/runner.py');
  assert.ok(args.includes('--exec'));assert.ok(args.includes('--user'));
  for(const v of ['Ubuntu','StarportWork-abc','x;cmd.exe'])assert.throws(()=>wslArgs(v),/owned_wsl/);
});
test('stdio bridge cannot choose an arbitrary control port or hostname',async()=>{
  const p=child();let disconnected=false;const bridge=pipeBridge(p,{proxy:9},{onEvent:e=>{disconnected=e.type==='disconnected';}});
  p.stdout.write(JSON.stringify({type:'open',id:1,channel:'management',host:'127.0.0.1',port:18884})+'\n');
  assert.equal(disconnected,true);bridge.close();
});
test('stdio bridge relays fixed channels and closes peers when its control pipe exits',async t=>{
  const upstream=http.createServer((_q,r)=>r.end('project-data'));const port=await listen(upstream);t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const p=child(),frames=[];p.stdin.on('data',b=>frames.push(...b.toString().trim().split('\n').map(JSON.parse)));const bridge=pipeBridge(p,{compute:port});t.after(()=>bridge.close());
  p.stdout.write(JSON.stringify({type:'open',id:1,channel:'compute'})+'\n');
  p.stdout.write(JSON.stringify({type:'data',id:1,data:Buffer.from('GET / HTTP/1.1\r\nHost: service\r\nConnection: close\r\n\r\n').toString('base64')})+'\n');
  await new Promise(r=>setTimeout(r,80));assert.ok(frames.some(f=>f.data&&Buffer.from(f.data,'base64').includes(Buffer.from('project-data'))));
  p.emit('close',0);assert.ok(p.stdin.writableEnded);
});
test('compute credentials and host metadata stay on the operator side; other projects cannot read or cancel jobs',async t=>{
  const id='a'.repeat(32),observed=[];
  const upstream=http.createServer(async(req,res)=>{
    observed.push({path:req.url,auth:req.headers.authorization});res.setHeader('content-type','application/json');
    if(req.url==='/health')return res.end(JSON.stringify({ready:true,accepting_new_jobs:true,host:'private-host',ip:'private-address',limits:{server_max_cpus:24},cloud:{token:'operator-only'}}));
    res.end(JSON.stringify({id,status:'running',server_ip:'private-address',account:'operator-only'}));
  });const port=await listen(upstream);t.after(()=>{upstream.closeAllConnections();upstream.close();});
  const c=await createCompute({state:temp(t),connection:{url:`http://127.0.0.1:${port}`,token:'example-operator-token'}});t.after(()=>c.close());
  const request=(project,route,body)=>fetch(`http://127.0.0.1:${c.port}${route}`,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+c.capability(project)},body:body===undefined?undefined:JSON.stringify(body)});
  const health=await(await request('one','/health')).json();assert.equal(health.ready,true);assert.ok(!JSON.stringify(health).includes('private-'));
  const submitted=await(await request('one','/jobs',{entry:'train.py',files:{'train.py':Buffer.from('print(1)').toString('base64')}})).json();assert.match(submitted.id,/^[a-f0-9]{32}$/);assert.equal(submitted.node,'primary');assert.equal(submitted.account,undefined);
  assert.equal((await request('two',`/jobs/${submitted.id}/cancel`,{})).status,403);
  assert.equal((await request('two',`/jobs/${submitted.id}/logs`)).status,403);
  assert.deepEqual((await(await request('two','/jobs')).json()).jobs,[]);
  assert.ok(observed.every(v=>v.auth==='Bearer example-operator-token'));
  assert.equal((await request('one','/management/resume',{})).status,403);
});
test('uncertain submission is recorded without an automatic resubmission',async t=>{
  let calls=0;const c=await createCompute({state:temp(t),connection:{url:'http://127.0.0.1:9',token:'example'},fetcher:async()=>{calls++;throw Error('private-host-error');}});t.after(()=>c.close());
  const r=await fetch(`http://127.0.0.1:${c.port}/jobs`,{method:'POST',headers:{authorization:'Bearer '+c.capability('main')},body:JSON.stringify({files:{'train.py':'eA=='}})});
  assert.equal(r.status,503);assert.equal(calls,1);assert.match((await r.json()).error,/outcome_unknown/);assert.equal(c.jobs()[0].outcomeUnknown,true);
});
test('Access requires signed matching issuer audience expiry and allowed email, not an identity header',async()=>{
  const {publicKey,privateKey}=await generateKeyPair('RS256'),jwk=await exportJWK(publicKey);jwk.kid='test';
  const c={issuer:'https://team.example.cloudflareaccess.com',audience:'example-audience',allowedEmails:['operator@example.com']};
  const make=claims=>new SignJWT({email:'operator@example.com',...claims}).setProtectedHeader({alg:'RS256',kid:'test'}).setIssuer(c.issuer).setAudience(c.audience).setSubject('example-subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const keySet=createLocalJWKSet({keys:[jwk]});
  assert.equal(await verifyAccess(await make({}),c,{keySet}),'example-subject');
  await assert.rejects(verifyAccess(await make({email:'other@example.com'}),c,{keySet}),/access_denied/);
  await assert.rejects(verifyAccess(await make({}),{...c,audience:'other'},{keySet}));
});
test('local management rejects spoofed Host, forwarded headers and cross-origin writes',()=>{
  const a=createAccess({port:18884,key:'example-key'}),req={headers:{host:'127.0.0.1:18884'},socket:{remoteAddress:'127.0.0.1'}};
  const policy=a.policy(req);assert.equal(policy.mode,'local');
  assert.throws(()=>a.policy({...req,headers:{...req.headers,'cf-access-authenticated-user-email':'operator@example.com'}}),/local_access_denied/);
  assert.throws(()=>a.policy({...req,headers:{host:'evil.example.com'}}),/host_not_allowed/);
  assert.throws(()=>a.check({...req,headers:{origin:'https://evil.example.com','x-csrf-token':a.csrf('local-operator')}},policy,'local-operator'),/csrf/);
});
test('panel defaults closed, uses private login and cannot enable a missing proxy',async t=>{
  const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-panel-')),s=await startHostControl(d,{port:0});t.after(async()=>{await s.close();fs.rmSync(d,{recursive:true,force:true});});
  const initial=await fetch(s.url+'api/status');assert.equal(initial.status,403);
  const key=JSON.parse(fs.readFileSync(path.join(d,'panel-key.json'))).key;
  const login=await fetch(s.url+'api/login',{method:'POST',headers:{origin:s.url.slice(0,-1),'content-type':'application/json'},body:JSON.stringify({key})});
  assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
  const status=await(await fetch(s.url+'api/status',{headers:{cookie}})).json();assert.equal(status.egress.enabled,false);assert.equal(status.compute.ready,false);assert.equal(JSON.stringify(status).includes(key),false);
  const resume=await fetch(s.url+'api/egress/resume',{method:'POST',headers:{cookie,origin:s.url.slice(0,-1),'x-csrf-token':status.csrf},body:'{}'});assert.equal(resume.status,403);
  assert.match((await resume.json()).error,/proxy_not_running/);
});
test('control configuration resolves only relative private paths',t=>{
  const d=temp(t),f=path.join(d,'config.json');fs.writeFileSync(f,JSON.stringify({format:'starport-host-control',version:1,wslState:'../escape'}));
  assert.throws(()=>loadControlOptions(f),/relative_control_path/);
});
test('WSLg configuration is opt-in and rejects ambiguous string values',t=>{
  const f=path.join(temp(t),'config.json'),base={format:'starport-host-control',version:1,wslState:'wsl'};
  fs.writeFileSync(f,JSON.stringify(base));assert.equal(loadControlOptions(f).wslg,false);
  fs.writeFileSync(f,JSON.stringify({...base,wslg:true}));assert.equal(loadControlOptions(f).wslg,true);
  fs.writeFileSync(f,JSON.stringify({...base,wslg:'false'}));assert.throws(()=>loadControlOptions(f),/invalid_wslg_configuration/);
});
test('control rejects stale runtime verification before SDK or native launch',async t=>{
  const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-proof-'));
  const s=await startHostControl(d,{port:0,wslg:true});t.after(async()=>{await s.close();fs.rmSync(d,{recursive:true,force:true});});
  const key=JSON.parse(fs.readFileSync(path.join(d,'panel-key.json'))).key;
  const headers={origin:s.url.slice(0,-1),'content-type':'application/json'};
  const login=await fetch(s.url+'api/login',{method:'POST',headers,body:JSON.stringify({key})});
  headers.cookie=login.headers.get('set-cookie').split(';')[0];
  const status=await(await fetch(s.url+'api/status',{headers})).json();headers['x-csrf-token']=status.csrf;
  s.runtime.reports.set('main',{passed:true,checkedAt:new Date().toISOString(),runtimeDigest:'previous-runtime'});
  assert.equal(s.runtime.status().reports[0].passed,false);
  for(const operation of ['sdk','native','clients']){
    const r=await fetch(s.url+'api/workspaces/main/'+operation,{method:'POST',headers,body:JSON.stringify({app:'browser',prompt:'test'})});
    assert.equal(r.status,403);assert.equal((await r.json()).error,'workspace_verification_required');
  }
  s.runtime.reports.set('main',{passed:true,checkedAt:new Date(Date.now()-86400001).toISOString(),runtimeDigest:s.runtime.digest()});
  assert.equal(s.runtime.status().reports[0].passed,false);
  const stopped=await fetch(s.url+'api/workspaces/main/native',{method:'POST',headers,body:JSON.stringify({app:'stop'})});
  assert.equal(stopped.status,200);assert.equal((await stopped.json()).phase,'stopped');
});
test('tunnel needs Access and reads its token from a private file, not argv or workspace environment',t=>{
  const d=temp(t),tokenFile=path.join(d,'tunnel-token');fs.writeFileSync(tokenFile,'example-tunnel-token',{mode:0o600});
  assert.throws(()=>startTunnel(d,{tokenFile,binary:'example-cloudflared'}),/access_required/);
  let argv,environment;const process=new EventEmitter();process.kill=()=>{};
  const handle=startTunnel(d,{tokenFile,binary:'example-cloudflared'},{issuer:'https://team.cloudflareaccess.com',hostname:'console.example.com',audience:'example',allowedEmails:['operator@example.com']},
    {spawnProcess:(_binary,args,options)=>{argv=args;environment=options.env;return process;}});
  assert.ok(argv.includes('--token-file'));assert.ok(!argv.includes('example-tunnel-token'));assert.equal(environment.TUNNEL_TOKEN,undefined);
  assert.equal(handle.status().publicAccessVerified,false);handle.close();assert.equal(handle.status().phase,'stopped');
});
test('managed SSH forwards only a loopback training API and never a remote shell or agent',()=>{
  const c={host:'compute.example.com',user:'operator',identityFile:'private/key',knownHostsFile:'private/hosts',serverPort:19090};
  const a=computeSshArgs(c,19091,'win32');assert.ok(a.includes('-NT'));assert.ok(a.includes('NUL'));assert.ok(a.includes('ForwardAgent=no'));assert.ok(a.includes('IdentityAgent=none'));assert.ok(a.includes('StrictHostKeyChecking=yes'));assert.ok(a.includes('127.0.0.1:19091:127.0.0.1:19090'));
  assert.equal(a.at(-1),'operator@compute.example.com');
  assert.throws(()=>computeSshArgs({...c,host:'-oProxyCommand=bad'},19091),/invalid_compute/);
});
