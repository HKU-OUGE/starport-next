#!/usr/bin/env node
// Read-only loopback diagnostics; never expose a key, cookie, bus or input text.
import fs from 'node:fs';
import path from 'node:path';
try{
  const args=process.argv.slice(2),o={};
  while(args.length){const k=args.shift(),v=args.shift();if(!['--state','--workspace'].includes(k)||!v||k in o)throw Error('invalid_arguments');o[k]=v;}
  const state=path.resolve(o['--state']||'private/control'),workspace=o['--workspace']||'main';
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw Error('invalid_workspace');
  const record=JSON.parse(fs.readFileSync(path.join(state,'control.json'))),key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'))).key;
  if(record.phase!=='running'||!Number.isInteger(record.port)||record.port<1024||record.port>65535||!/^[a-f0-9]{64}$/.test(key))throw Error('control_not_ready');
  const origin='http://127.0.0.1:'+record.port;let cookie='',csrf='';
  const request=async(route,body)=>{const r=await fetch(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',headers:{origin,cookie,'content-type':'application/json','x-csrf-token':csrf},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(60000)});if(route==='/api/login')cookie=r.headers.get('set-cookie')?.split(';')[0]||'';const v=await r.json();if(!r.ok)throw Error(/^[a-z_]+$/.test(v.error)?v.error:'ime_diagnostic_failed');return v;};
  await request('/api/login',{key});const status=await request('/api/status');csrf=status.csrf;
  if(!status.workspaces.includes(workspace))throw Error('unknown_workspace');
  const verified=status.runtime.reports.some(v=>v.workspace===workspace&&v.passed),native=status.runtime.native.find(v=>v.workspace===workspace);
  let installed=null;if(verified)installed=(await request('/api/workspaces/'+workspace+'/clients',{})).inputMethodInstalled===true;
  const preflightReady=verified&&installed===true&&native?.phase==='running'&&native?.ime?.phase==='ready';
  const r={platform:status.control.platform,runtime:status.runtime.kind,workspace,preflightReady,boundaryVerified:verified,inputMethodInstalled:installed,
    graphicsSession:native?.phase||'not_started',display:native?.display||null,inputMethod:native?.ime||null,
    manualCheck:['Candidate window visible','Traditional Chinese commit','English and punctuation','Explicit simplified Chinese selection','Two project windows stay independent'],
    keyboardInputVerified:false};
  console.log(JSON.stringify(r,null,2));if(!preflightReady)process.exitCode=2;
}catch(e){console.error(JSON.stringify({ok:false,error:/^[a-z_]+$/.test(e.message)?e.message:'ime_diagnostic_failed'}));process.exitCode=1;}
