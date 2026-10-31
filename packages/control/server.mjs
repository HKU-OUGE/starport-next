import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { privateDir,writePrivate,read,error } from '../runtime/common.mjs';
import { managedProxy } from '../runtime/managed-proxy.mjs';
import { createEgress,DEFAULT_HOSTS } from '../runtime/egress.mjs';
import { NATIVE_HOSTS } from '../runtime/native.mjs';
import { createWslRuntime } from '../wsl/runtime.mjs';
import { createCompute,bodyJson,jsonResponse } from './compute.mjs';
import { createAccess } from './access.mjs';
import { startTunnel } from './tunnel.mjs';
import { startComputeSsh } from './ssh-tunnel.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const workspaceId=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(v);
export async function startHostControl(state,options={}){
  state=privateDir(state);
  const lock=path.join(state,'control.lock');
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}catch{throw error('control_already_started_or_requires_reconciliation');}
  let proxy,egress,compute,runtime,server,timer,tunnel,computeSsh;
  const workspaceFile=path.join(state,'workspaces.json');
  const workspaces=fs.existsSync(workspaceFile)?read(workspaceFile):['main'];
  if(!Array.isArray(workspaces)||workspaces.some(v=>!workspaceId(v)))throw error('invalid_workspace_registry');
  const keyFile=path.join(state,'panel-key.json');
  if(!fs.existsSync(keyFile))writePrivate(keyFile,{key:crypto.randomBytes(32).toString('hex')});
  const key=read(keyFile).key;
  let proxyRunning=false,health={ready:false,error:'checking'},refreshedAt=null,refreshing=false,verifying=false;
  try{
    if(options.proxyCandidates){proxy=await managedProxy(state,options.proxyCandidates,{binary:options.proxyBinary,onExit:()=>{proxyRunning=false;egress?.pause();}});proxyRunning=true;}
    egress=options.testEgress||await createEgress({upstream:proxy?.upstream||{kind:'http',url:'http://127.0.0.1:9'},
      hosts:[...new Set([...DEFAULT_HOSTS,...NATIVE_HOSTS,...(options.hosts||[])])],apiKey:options.apiKey,model:options.model});
    if(!proxy&&!options.testEgress)egress.pause();
    if(options.compute?.ssh)computeSsh=await startComputeSsh(options.compute.ssh);
    compute=await createCompute({state,connection:options.compute?{url:computeSsh?.url||options.compute.url,token:options.compute.token}:undefined});
    runtime=createWslRuntime(options.wslState||path.join(state,'wsl'),{launch:options.testLaunch,
      destinations:{proxy:egress.proxyPort,model:egress.apiPort,compute:compute.port},
      capabilities:workspace=>({modelCapability:egress.modelReady?egress.capability:undefined,computeCapability:compute.capability(workspace)})});
    const refresh=async()=>{if(refreshing)return;refreshing=true;try{health=await compute.health();refreshedAt=new Date().toISOString();}finally{refreshing=false;}};
    await refresh();timer=setInterval(refresh,10000);timer.unref();
    let access;
    const json=(res,status,value)=>jsonResponse(res,status,value);
    server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
      try{
        const policy=access.policy(req),url=new URL(req.url,'http://control.invalid');
        if(req.method==='GET'&&['/','/app.js','/style.css'].includes(url.pathname)){
          if(policy.mode==='cloudflare')await access.authenticate(req,policy);
          const name=url.pathname==='/'?'index.html':url.pathname.slice(1);
          res.writeHead(200,{'content-type':name.endsWith('.js')?'text/javascript; charset=utf-8':name.endsWith('.css')?'text/css; charset=utf-8':'text/html; charset=utf-8','cache-control':'no-store'});
          return res.end(fs.readFileSync(path.join(root,'web',name)));
        }
        if(url.pathname==='/api/login'&&req.method==='POST'&&policy.mode==='local'){
          if(req.headers.origin!==policy.origin)throw error('origin_denied');
          const b=await bodyJson(req,4096);if(!access.login(b.key))throw error('authentication_required');
          res.setHeader('Set-Cookie',`starport_control=${access.cookie}; HttpOnly; SameSite=Strict; Path=/`);
          return json(res,200,{ok:true});
        }
        const identity=await access.authenticate(req,policy);
        if(req.method!=='GET')access.check(req,policy,identity);
        if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{
          control:{platform:process.platform,kind:'native-host',remote:policy.mode,updatedAt:refreshedAt},
          egress:{enabled:egress.enabled,configured:proxyRunning||!!options.testEgress,directFallback:false},
          runtime:runtime.status(),workspaces,compute:health,jobs:compute.jobs(),tunnel:tunnel?.status()||{phase:'not-configured'},csrf:access.csrf(identity)});
        if(req.method==='POST'&&url.pathname.startsWith('/api/egress/')){
          if(verifying)throw error('workspace_verification_in_progress');
          if(url.pathname==='/api/egress/pause')egress.pause();
          else if(url.pathname==='/api/egress/resume'){
            if(!proxyRunning&&!options.testEgress)throw error('controlled_proxy_not_running');egress.resume();
          }else throw error('unknown_route');
          return json(res,200,{enabled:egress.enabled});
        }
        if(req.method==='POST'&&url.pathname==='/api/workspaces'){
          const b=await bodyJson(req,4096);if(!workspaceId(b.id)||workspaces.includes(b.id))throw error('invalid_or_existing_workspace');
          workspaces.push(b.id);writePrivate(workspaceFile,workspaces);return json(res,201,{id:b.id});
        }
        const m=/^\/api\/workspaces\/([a-z][a-z0-9-]{0,47})\/(verify|exec|files)$/.exec(url.pathname);
        if(req.method==='POST'&&m&&workspaces.includes(m[1])){
          const [,_id,operation]=m,b=await bodyJson(req);
          if(verifying)throw error('workspace_verification_in_progress');
          if(operation==='verify'){
            // Only this workspace is probed. Do not interrupt other local operations.
            if(runtime.status().active.length)throw error('workspace_operations_active');
            if(!egress.enabled)throw error('enable_controlled_egress_first');
            verifying=true;
            try{
            const script=fs.readFileSync(new URL('../wsl/probe.py',import.meta.url),'utf8');
            const execute=()=>runtime.execute(_id,{operation:'exec',argv:['/usr/bin/python3','-I','-c',script]},{timeout:45000});
            const normal=await execute();if(normal.code!==0)throw error('workspace_probe_failed');
            const checks=JSON.parse(normal.stdout);let closed;
            egress.pause();try{const r=await execute();if(r.code!==0)throw error('workspace_probe_failed');closed=JSON.parse(r.stdout);}finally{if(proxyRunning||options.testEgress)egress.resume();}
            const booleans=Object.entries(checks).filter(([,v])=>typeof v==='boolean');
            const receipt={checkedAt:new Date().toISOString(),passed:checks.hostname==='starship'&&checks.user==='agent'&&checks.timezone==='Asia/Taipei'&&checks.language==='zh_TW.UTF-8'&&booleans.length>=11&&booleans.every(([,v])=>v)&&closed.controlledHttps===false&&closed.directTcpDenied===true,checks,proxyStopped:{requestDenied:!closed.controlledHttps,directStillDenied:closed.directTcpDenied}};
            runtime.reports.set(_id,receipt);return json(res,200,receipt);
            }finally{verifying=false;}
          }
          if(operation==='exec'){
            const proof=runtime.reports.get(_id);
            if(!proof?.passed||Date.now()-Date.parse(proof.checkedAt)>86400000)throw error('workspace_verification_required');
            if(typeof b.script!=='string'||b.script.length>131072)throw error('invalid_script');
            return json(res,200,await runtime.execute(_id,{operation:'exec',argv:['/bin/bash','--noprofile','--norc','-c',b.script]},{timeout:120000}));
          }
          const r=await runtime.execute(_id,{operation:'files',request:b});
          let result;try{result=JSON.parse(r.stdout);}catch{throw error('workspace_file_operation_failed');}
          return json(res,r.code===0?200:400,result);
        }
        return json(res,404,{error:'unknown_route'});
      }catch(e){if(!res.headersSent)json(res,403,{error:/^[a-z][a-z0-9_]{1,79}$/.test(e.code||'')?e.code:'control_request_failed'});else res.end();}
    });
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port??18884,'127.0.0.1',resolve);});
    const port=server.address().port;access=createAccess({port,key,access:options.access});
    if(options.tunnel)tunnel=startTunnel(state,options.tunnel,options.access);
    const result={port,url:`http://127.0.0.1:${port}/`,phase:'running',platform:process.platform,pid:process.pid};
    writePrivate(path.join(state,'control.json'),result);
    return {...result,runtime,egress,compute,async close(){clearInterval(timer);runtime.close();compute.close();computeSsh?.close();egress.close();proxy?.close();tunnel?.close();server.closeAllConnections();server.close();writePrivate(path.join(state,'control.json'),{...result,phase:'stopped'});fs.rmSync(lock,{force:true});}};
  }catch(e){clearInterval(timer);runtime?.close();compute?.close();computeSsh?.close();egress?.close();proxy?.close();tunnel?.close();server?.close();fs.rmSync(lock,{force:true});throw e;}
}
