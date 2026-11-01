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
import { openWorkspaceFolder } from './explorer.mjs';
import { createConfigurationTransfer } from './config-transfer.mjs';
import { createJobManagement } from './job-management.mjs';
import { createServices } from './services.mjs';
import { createRemoteSettings } from './remote-settings.mjs';
import { loadControlOptions } from './config.mjs';
import {createViewer,viewerAsset} from './viewer.mjs';
import {webDocument} from './web-document.mjs';

const root=fileURLToPath(new URL('.',import.meta.url));
const workspaceId=v=>typeof v==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(v);
export async function startHostControl(state,options={}){
  state=privateDir(state);
  const lock=path.join(state,'control.lock');
  try{fs.writeFileSync(lock,JSON.stringify({pid:process.pid}),{flag:'wx',mode:0o600});}catch{throw error('control_already_started_or_requires_reconciliation');}
  let proxy,egress,compute,runtime,server,timer,tunnel,viewer;const computeSsh=[];
  const workspaceFile=path.join(state,'workspaces.json');
  const workspaces=fs.existsSync(workspaceFile)?read(workspaceFile):['main'];
  if(!Array.isArray(workspaces)||workspaces.some(v=>!workspaceId(v)))throw error('invalid_workspace_registry');
  const keyFile=path.join(state,'panel-key.json');
  if(!fs.existsSync(keyFile))writePrivate(keyFile,{key:crypto.randomBytes(32).toString('hex')});
  const key=read(keyFile).key;
  const configuration=createConfigurationTransfer(state,options.configurationFile);
  const services=createServices(state,options.configurationFile,options.testServices);
  let proxyRunning=false,health={ready:false,error:'checking'},refreshedAt=null,refreshing=false,verifying=false;
  try{
    if(options.proxyCandidates){proxy=await managedProxy(state,options.proxyCandidates,{binary:options.proxyBinary,onExit:()=>{proxyRunning=false;egress?.pause();}});proxyRunning=true;}
    egress=options.testEgress||await createEgress({upstream:proxy?.upstream||{kind:'http',url:'http://127.0.0.1:9'},
      hosts:[...new Set([...DEFAULT_HOSTS,...NATIVE_HOSTS,...(options.hosts||[])])],apiKey:options.apiKey,model:options.model});
    if(!proxy&&!options.testEgress)egress.pause();
    const connections=[];
    for(const node of options.computeNodes||(options.compute?[{...options.compute,id:'primary',name:'主服务器'}]:[])){
      if(!node.ssh){connections.push(node);continue;}
      try{const ssh=await startComputeSsh(node.ssh);computeSsh.push(ssh);connections.push({...node,url:ssh.url});}
      catch{connections.push({...node,url:undefined,unavailable:true});}
    }
    compute=await createCompute({state,connections,defaultNode:options.defaultComputeNode});
    const jobs=createJobManagement(compute);
    runtime=createWslRuntime(options.wslState||path.join(state,'wsl'),{launch:options.testLaunch,wslg:options.wslg===true,
      destinations:{proxy:egress.proxyPort,model:egress.apiPort,compute:compute.port},
      capabilities:workspace=>({modelCapability:egress.modelReady?egress.capability:undefined,computeCapability:compute.capability(workspace)})});
    const refresh=async()=>{if(refreshing)return;refreshing=true;try{health=await compute.health();refreshedAt=new Date().toISOString();}finally{refreshing=false;}};
    await refresh();timer=setInterval(refresh,10000);timer.unref();
    let access,activeAccess=options.access;
    const remoteSettings=createRemoteSettings(options.configurationFile,{
      port:()=>server.address().port,
      active:()=>({enabled:!!activeAccess,hostname:activeAccess?.hostname||null,tunnel:tunnel?.status()||{phase:'not-configured'}}),
      activate:async()=>{
        const next=loadControlOptions(options.configurationFile),nextAccess=createAccess({port:server.address().port,key,access:next.access});
        const nextTunnel=next.tunnel?startTunnel(state,next.tunnel,next.access):undefined;
        access=nextAccess;activeAccess=next.access;tunnel?.close();tunnel=nextTunnel;
      }
    });
    const json=(res,status,value)=>jsonResponse(res,status,value);
    server=http.createServer(async(req,res)=>{
      res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
      res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Content-Type-Options','nosniff');
      try{
        const policy=access.policy(req),url=new URL(req.url,'http://control.invalid');
        if(req.method==='GET'&&url.pathname.startsWith('/novnc/')){
          await access.authenticate(req,policy);const bytes=viewerAsset(url.pathname);
          res.writeHead(200,{'content-type':'text/javascript; charset=utf-8','cache-control':'no-store'});return res.end(bytes);
        }
        if(req.method==='GET'&&['/','/app.js','/operations.js','/shell.js','/remote.js','/resources.js','/viewer.js','/style.css'].includes(url.pathname)){
          if(policy.mode==='cloudflare')await access.authenticate(req,policy);
          if(url.pathname==='/'){
            const page=await webDocument();res.setHeader('Content-Security-Policy',page.csp);
            const gzip=/\bgzip\b/.test(req.headers['accept-encoding']||'');
            res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store','vary':'Accept-Encoding',...(gzip?{'content-encoding':'gzip'}:{})});return res.end(gzip?page.gzip:page.html);
          }
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
        if(['/api/resources','/api/resources/disable','/api/resources/auto-conda'].includes(url.pathname)){
          if(policy.mode!=='local')throw error('local_resource_action_required');
          if(req.method==='GET'&&url.pathname==='/api/resources')return json(res,200,await compute.resources(url.searchParams.get('node')||undefined));
          if(req.method==='POST'){
            const b=await bodyJson(req,8192);
            if(!b||Array.isArray(b))throw error('invalid_resource_registration');
            const {node,reviewed,...input}=b;
            if(!url.pathname.endsWith('/disable')&&reviewed!==true)throw error('resource_content_review_required');
            return json(res,200,await compute.manageResource(node,url.pathname.endsWith('/disable')?'disable':url.pathname.endsWith('/auto-conda')?'auto-conda':'register',input));
          }
          throw error('unknown_route');
        }
        if(url.pathname==='/api/remote-access'||url.pathname==='/api/remote-access/check'){
          if(policy.mode!=='local')throw error('local_remote_settings_required');
          if(req.method==='GET'&&url.pathname==='/api/remote-access')return json(res,200,remoteSettings.snapshot());
          if(req.method==='POST'&&url.pathname==='/api/remote-access')return json(res,200,await remoteSettings.save(await bodyJson(req,128*1024)));
          if(req.method==='POST'&&url.pathname==='/api/remote-access/check'){await bodyJson(req,1024);return json(res,200,await remoteSettings.check());}
          throw error('unknown_route');
        }
        if(req.method==='GET'&&url.pathname==='/api/nodes')return json(res,200,{nodes:health.nodes||[],defaultNode:health.defaultNode,summary:health.summary});
        const admission=/^\/api\/nodes\/([a-z][a-z0-9-]{0,47})\/admission$/.exec(url.pathname);
        if(req.method==='POST'&&admission){
          const b=await bodyJson(req,1024),result=compute.admission(admission[1],b.paused);await refresh();return json(res,200,result);
        }
        if(url.pathname==='/api/services'||url.pathname.startsWith('/api/services/')){
          if(policy.mode!=='local')throw error('local_service_action_required');
          if(req.method==='GET'&&url.pathname==='/api/services')return json(res,200,await services.status());
          const action=/^\/api\/services\/(enable|disable|start)$/.exec(url.pathname)?.[1];
          if(req.method==='POST'&&action){await bodyJson(req,1024);return json(res,200,await services.action(action));}
          throw error('unknown_route');
        }
        if(url.pathname==='/api/jobs'&&req.method==='GET')return json(res,200,{jobs:compute.jobs()});
        if(url.pathname==='/api/jobs/refresh'&&req.method==='POST'){await bodyJson(req,1024);return json(res,200,await jobs.refresh());}
        const task=/^\/api\/jobs\/([a-f0-9]{32})(?:\/(logs|cancel|artifact))?$/.exec(url.pathname);
        if(task){
          const [,id,operation]=task;
          if(req.method==='GET'&&!operation)return json(res,200,await jobs.detail(id));
          if(req.method==='GET'&&operation==='logs')return json(res,200,await jobs.logs(id,Number(url.searchParams.get('cursor')||0)));
          if(req.method==='POST'&&operation==='cancel'){await bodyJson(req,1024);return json(res,200,await jobs.cancel(id));}
          if(req.method==='GET'&&operation==='artifact'){
            const {response,artifact}=await jobs.artifact(id,url.searchParams.get('path'));
            // Worker transfers already verify each chunk. Older manifests have
            // size only; hash the bounded complete transfer before serving it.
            const chunks=[];let bytes=0;const hash=crypto.createHash('sha256');
            for await(const chunk of response.body){bytes+=chunk.length;if(bytes>artifact.bytes||bytes>64*1024*1024)throw error('artifact_integrity_mismatch');hash.update(chunk);chunks.push(chunk);}
            const sha256=hash.digest('hex');
            if(bytes!==artifact.bytes||artifact.sha256&&sha256!==artifact.sha256)throw error('artifact_integrity_mismatch');
            res.writeHead(200,{'content-type':'application/octet-stream','content-disposition':"attachment; filename*=UTF-8''"+encodeURIComponent(artifact.path.split('/').at(-1)),
              'content-length':bytes,'x-content-sha256':sha256,'cache-control':'no-store'});
            res.end(Buffer.concat(chunks,bytes));return;
          }
          throw error('unknown_route');
        }
        if(url.pathname==='/api/configuration'||url.pathname.startsWith('/api/configuration/')){
          if(policy.mode!=='local')throw error('local_configuration_action_required');
          if(req.method==='GET'&&url.pathname==='/api/configuration')return json(res,200,await configuration.list());
          const action=/^\/api\/configuration\/(preview|import|export)$/.exec(url.pathname)?.[1];
          if(req.method==='POST'&&action)return json(res,200,await configuration.handle(action,await bodyJson(req,32*1024*1024)));
          throw error('unknown_route');
        }
        if(req.method==='GET'&&url.pathname==='/api/status')return json(res,200,{
          control:{platform:process.platform,kind:'native-host',remote:policy.mode,updatedAt:refreshedAt},
          egress:{enabled:egress.enabled,configured:proxyRunning||!!options.testEgress,directFallback:false},
          runtime:runtime.status(),model:{configured:egress.modelReady,model:options.model||null},workspaces,compute:health,jobs:compute.jobs(),tunnel:tunnel?.status()||{phase:'not-configured'},csrf:access.csrf(identity)});
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
        const m=/^\/api\/workspaces\/([a-z][a-z0-9-]{0,47})\/(verify|exec|files|native|sdk|clients|open-folder|viewer-ticket)$/.exec(url.pathname);
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
            receipt.runtimeDigest=runtime.digest();runtime.reports.set(_id,receipt);return json(res,200,receipt);
            }finally{verifying=false;}
          }
          if(['exec','native','sdk','clients','open-folder','viewer-ticket'].includes(operation)){
            // Stopping an owned GUI session must remain possible during an idle
            // runtime upgrade, when its previous verification is already stale.
            if(operation==='native'&&b.app==='stop'){await runtime.stopNative(_id);return json(res,200,{phase:'stopped'});}
            const proof=runtime.reports.get(_id);
            if(!proof?.passed||proof.runtimeDigest!==runtime.digest()||Date.now()-Date.parse(proof.checkedAt)>86400000)throw error('workspace_verification_required');
            if(operation==='viewer-ticket')return json(res,200,viewer.ticket(_id,identity));
            if(operation==='open-folder'){
              if(policy.mode!=='local'||process.platform!=='win32')throw error('local_windows_action_required');
              return json(res,200,await openWorkspaceFolder(options.wslState||path.join(state,'wsl'),_id));
            }
            if(operation==='clients'){
              const r=await runtime.execute(_id,{operation:'exec',argv:['/usr/bin/python3','-I','/opt/starport/client-status.py']},{timeout:45000});
              if(r.code!==0)throw error('client_status_failed');return json(res,200,JSON.parse(r.stdout));
            }
            if(operation==='native'){
              return json(res,200,await runtime.nativeAction(_id,b.app,b.display||'wslg'));
            }
            if(operation==='sdk'){
              if(!egress.modelReady)throw error('api_gateway_required');
              if(typeof b.prompt!=='string'||!b.prompt.trim()||b.prompt.length>65536)throw error('invalid_prompt');
              return json(res,200,await runtime.execute(_id,{operation:'sdk',request:{prompt:b.prompt,resume:b.resume,model:options.model||'claude-haiku-5-5'}},{timeout:300000}));
            }
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
    viewer=createViewer(server,{access:()=>access,runtime,verify:id=>{
      const proof=runtime.reports.get(id);
      if(!workspaces.includes(id)||!proof?.passed||proof.runtimeDigest!==runtime.digest()||Date.now()-Date.parse(proof.checkedAt)>86400000)throw error('workspace_verification_required');
    }});
    await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port??18884,'127.0.0.1',resolve);});
    const port=server.address().port;access=createAccess({port,key,access:options.access});
    if(options.tunnel)tunnel=startTunnel(state,options.tunnel,options.access);
    const result={port,url:`http://127.0.0.1:${port}/`,phase:'running',platform:process.platform,pid:process.pid};
    writePrivate(path.join(state,'control.json'),result);
    return {...result,runtime,egress,compute,async close(){clearInterval(timer);viewer.close();runtime.close();compute.close();computeSsh.forEach(s=>s.close());egress.close();proxy?.close();tunnel?.close();server.closeAllConnections();server.close();writePrivate(path.join(state,'control.json'),{...result,phase:'stopped'});fs.rmSync(lock,{force:true});}};
  }catch(e){clearInterval(timer);viewer?.close();runtime?.close();compute?.close();computeSsh.forEach(s=>s.close());egress?.close();proxy?.close();tunnel?.close();server?.close();fs.rmSync(lock,{force:true});throw e;}
}
