import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {createSessions} from '../packages/control/sessions.mjs';
import {startHostControl} from '../packages/control/server.mjs';

const uuid=()=>crypto.randomUUID();
const sdkId='12345678-1234-1234-1234-123456789abc';
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t){
  const state=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-sessions-'));t.after(()=>fs.rmSync(state,{recursive:true,force:true}));
  const calls=[],running=new Map();let permitted=true;
  const runtime={status:()=>({active:[...running].map(([workspace])=>({workspace,operation:'sdk'}))}),
    execute(workspace,request,options){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});
      const run={workspace,request,options,resolve:value=>{running.delete(workspace);resolve(value);},reject:err=>{running.delete(workspace);reject(err);}};
      calls.push(run);running.set(workspace,run);return promise;},
    async cancelSdk(workspace){running.get(workspace)?.reject(Object.assign(Error('disconnected'),{code:'workspace_control_disconnected'}));}
  };
  const options={runtime,workspaces:['main','other'],model:'test-model',authorize:()=>{if(!permitted)throw Error('verification_required');}};
  const manager=createSessions(state,options);
  const make=(workspace='main')=>manager.create({workspace,title:'测试会话',requestId:uuid()});
  const emit=(run,event)=>run.options.onOutput({stream:'stdout',text:JSON.stringify(event)+'\n'});
  const finish=async(run)=>{emit(run,{type:'result',session_id:sdkId,is_error:false,total_cost_usd:0.01});run.resolve({code:0});await tick();};
  return {state,options,manager,make,calls,emit,finish,permission:v=>{permitted=v;}};
}

test('session and message request IDs deduplicate lost acknowledgements and reject changed payloads',async t=>{
  const f=fixture(t),creation={workspace:'main',title:'one',requestId:uuid()},s=f.manager.create(creation);
  assert.equal(f.manager.create(creation).id,s.id);assert.throws(()=>f.manager.create({...creation,title:'two'}),/request_id_conflict/);
  const input={prompt:'你好 `unchanged_path`',requestId:uuid()};f.manager.start(s.id,input);
  assert.equal(f.manager.start(s.id,input).reused,true);assert.equal(f.calls.length,1);
  assert.throws(()=>f.manager.start(s.id,{...input,prompt:'different'}),/request_id_conflict/);
  await f.finish(f.calls[0]);assert.equal(f.manager.start(s.id,input).turn.status,'completed');
  assert.equal(f.manager.snapshot(s.id).events.filter(e=>e.type==='prompt').length,1);
});

test('SDK context is captured from output and bound to one project instead of browser resume parameters',async t=>{
  const f=fixture(t),s=f.make();f.manager.start(s.id,{prompt:'first',requestId:uuid(),resume:'malicious'});
  assert.equal(f.calls[0].request.request.resume,undefined);
  const line=JSON.stringify({type:'system',subtype:'init',session_id:sdkId})+'\n';
  f.calls[0].options.onOutput({stream:'stdout',text:line.slice(0,19)});f.calls[0].options.onOutput({stream:'stdout',text:line.slice(19)});
  await f.finish(f.calls[0]);f.manager.start(s.id,{prompt:'follow up',requestId:uuid(),resume:uuid(),workspace:'other'});
  assert.equal(f.calls[1].workspace,'main');assert.equal(f.calls[1].request.request.resume,sdkId);
  await f.finish(f.calls[1]);const page=f.manager.snapshot(s.id,2);assert.ok(page.events.every(e=>e.seq>2));
  assert.equal(page.session.resumable,true);assert.equal(page.session.sdkSessionId,undefined);
  assert.throws(()=>f.manager.update(s.id,{workspace:'other'}),/invalid_session_update/);
});

test('one SDK writer per project, scoped stop, reversible archive and no display session dependency',async t=>{
  const f=fixture(t),a=f.make(),b=f.make(),c=f.make('other');
  f.manager.start(a.id,{prompt:'one',requestId:uuid()});
  assert.throws(()=>f.manager.start(b.id,{prompt:'two',requestId:uuid()}),/workspace_busy/);
  f.manager.start(c.id,{prompt:'other',requestId:uuid()});
  assert.throws(()=>f.manager.update(a.id,{archived:true}),/session_busy/);
  await f.manager.stop(a.id);assert.equal(f.manager.snapshot(a.id).session.status,'cancelled');
  assert.equal(f.manager.snapshot(c.id).session.status,'running');await f.finish(f.calls[1]);
  f.manager.update(a.id,{archived:true});assert.equal(f.manager.list({archived:true}).length,1);
  f.manager.update(a.id,{archived:false,title:'恢复'});assert.equal(f.manager.snapshot(a.id).session.title,'恢复');
});

test('a stop racing a complete SDK result preserves the completed answer',async t=>{
  const f=fixture(t),s=f.make();f.manager.start(s.id,{prompt:'complete',requestId:uuid()});
  f.emit(f.calls[0],{type:'result',session_id:sdkId,is_error:false,total_cost_usd:0.02});
  await f.manager.stop(s.id);const view=f.manager.snapshot(s.id).session;
  assert.equal(view.status,'idle');assert.equal(view.turns[0].status,'completed');assert.equal(view.turns[0].costScope,'sdk-session-cumulative-estimate');
});

test('restart preserves history and context but marks unfinished work interrupted without replay',async t=>{
  const f=fixture(t),s=f.make();f.manager.start(s.id,{prompt:'first',requestId:uuid()});await f.finish(f.calls[0]);
  const file=path.join(f.state,'sessions',s.id+'.json'),metadata=JSON.parse(fs.readFileSync(file));
  metadata.status='running';metadata.turns[0].status='running';fs.writeFileSync(file,JSON.stringify(metadata));
  const restored=createSessions(f.state,f.options),view=restored.snapshot(s.id);
  assert.equal(view.session.status,'interrupted');assert.equal(view.session.resumable,true);assert.equal(f.calls.length,1);
  restored.start(s.id,{prompt:'continue explicitly',requestId:uuid()});assert.equal(f.calls[1].request.request.resume,sdkId);await f.finish(f.calls[1]);
});

test('verification, malformed history and path traversal fail closed',t=>{
  const f=fixture(t),s=f.make();f.permission(false);
  assert.throws(()=>f.manager.start(s.id,{prompt:'run',requestId:uuid()}),/verification_required/);assert.equal(f.calls.length,0);
  assert.throws(()=>f.manager.snapshot('../secrets'),/session_not_found/);
  fs.writeFileSync(path.join(f.state,'sessions',s.id+'.jsonl'),'{broken');
  assert.throws(()=>f.manager.snapshot(s.id),/session_history_requires_reconciliation/);
});

test('session HTTP routes require authentication, Origin and CSRF, with idempotent creation',async t=>{
  const state=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-chat-http-'));
  const egress={enabled:true,modelReady:false,proxyPort:9,apiPort:9,pause(){},resume(){},close(){}};
  const control=await startHostControl(state,{port:0,testEgress:egress});t.after(()=>{control.close();fs.rmSync(state,{recursive:true,force:true});});
  const base=control.url.slice(0,-1),key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'))).key;
  const post=(route,body,headers={})=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
  assert.equal((await fetch(base+'/api/sessions')).status,403);
  const login=await post('/api/login',{key}),Cookie=login.headers.get('set-cookie').split(';')[0];
  const status=await(await fetch(base+'/api/status',{headers:{Cookie}})).json(),input={workspace:'main',title:'API',requestId:uuid()};
  assert.equal((await post('/api/sessions',input,{Cookie})).status,403);
  const headers={Cookie,'X-CSRF-Token':status.csrf};
  assert.equal((await post('/api/sessions',input,{...headers,Origin:'https://other.example.com'})).status,403);
  const created=await post('/api/sessions',input,headers);assert.equal(created.status,201);const s=await created.json();
  assert.equal((await(await post('/api/sessions',input,headers)).json()).id,s.id);
  assert.equal((await post('/api/sessions/'+s.id+'/messages',{prompt:'run',requestId:uuid()},headers)).status,403);
});
