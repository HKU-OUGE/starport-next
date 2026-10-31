import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { privateDir, read, writePrivate, cleanEnv, sleep, executable } from './common.mjs';
import { qemuArgs, sshArgs, guest } from './qemu.mjs';
import { createEgress } from './egress.mjs';
import { managedProxy } from './managed-proxy.mjs';

const state=privateDir(process.argv[2]);
let input='';for await(const part of process.stdin){input+=part;if(input.length>65536)throw new Error('bootstrap_limit');}
const settings=JSON.parse(input);input='';
const settingsDigest=crypto.createHash('sha256').update(JSON.stringify(settings)).digest('hex'),runId=crypto.randomUUID();
const config=read(path.join(state,'machine.json'));
const token=crypto.randomBytes(32).toString('hex');
let machine,forward,control,egress,proxy,ready=false,closing=false,phase='starting',lastError=null;
const log=fs.openSync(path.join(state,'runtime.log'),'a',0o600);
const note=value=>fs.writeSync(log,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
function record(){writePrivate(path.join(state,'runtime.json'),{format:1,pid:process.pid,controlPort:control.address().port,token,sshPort,phase,ready,vmId:config.vmId,runId,settingsDigest,modelReady:Boolean(egress?.modelReady),egress:egress?.enabled?'available':'closed',lastError});}
async function shutdown(){
  if(closing)return;closing=true;ready=false;phase='stopping';record();egress?.close();forward?.kill();proxy?.close();
  if(machine?.stdin.writable){machine.stdin.write('{"execute":"qmp_capabilities"}\n{"execute":"system_powerdown"}\n');}
  for(let i=0;i<150&&machine&&machine.exitCode===null;i++)await sleep(200);
  if(machine?.exitCode===null){phase='stop_pending';lastError='guest_shutdown_not_confirmed';record();return;}
  finishStop();
}
function finishStop(){phase='stopped';record();control.close();setTimeout(()=>process.exit(0),250).unref();}
const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const sshPort=port;
control=http.createServer(async(req,res)=>{
  if(req.headers.authorization!==`Bearer ${token}`){res.writeHead(401);res.end();return;}
  if(req.headers.origin){res.writeHead(403);res.end();return;}
  res.setHeader('content-type','application/json');res.setHeader('cache-control','no-store');
  if(req.method==='GET'&&req.url==='/status'){res.end(JSON.stringify({running:machine?.exitCode===null,ready,phase,egress:egress?.enabled?'available':'closed',modelReady:egress?.modelReady,requests:egress?.requests,vmId:config.vmId,runId,settingsDigest,sshPort,lastError}));return;}
  if(req.method==='POST'&&req.url==='/stop'){res.end('{"stopping":true}');void shutdown();return;}
  if(req.method==='POST'&&['/egress/pause','/egress/resume'].includes(req.url)){req.url.endsWith('/pause')?egress.pause():egress.resume();record();res.end(JSON.stringify({egress:egress.enabled?'available':'closed'}));return;}
  res.writeHead(404);res.end('{}');
});
await new Promise(resolve=>control.listen(0,'127.0.0.1',resolve));record();
try{
  if(settings.proxyCandidates){proxy=await managedProxy(state,settings.proxyCandidates,{binary:settings.proxyBinary,onExit:()=>{if(!closing&&egress){egress.pause();ready=false;phase='proxy_stopped';record();}}});settings.upstream=proxy.upstream;}
  egress=await createEgress(settings);settings.apiKey=null;
  machine=spawn(executable(config.host.qemu),qemuArgs(config,state,sshPort),{env:cleanEnv(),shell:false,windowsHide:true,stdio:['pipe','pipe',log]});
  machine.on('error',()=>{lastError='qemu_start_failed';note({error:lastError});void shutdown();});
  machine.stdin.on('error',()=>{});
  machine.stdout.on('data',()=>{});
  machine.on('exit',()=>{if(!closing){lastError='virtual_machine_stopped';void shutdown();}else if(phase==='stop_pending')finishStop();});
  phase='booting';record();
  for(let i=0;i<100&&!closing;i++){
    const r=await guest(state,sshPort,'test -f /opt/starport/boot-ready && printf ready',{user:'control',timeout:6000});
    if(r.code===0&&r.stdout==='ready'){ready=true;break;}await sleep(1000);
  }
  if(!ready)throw new Error('guest_boot_timeout');ready=false;phase='connecting_egress';record();
  forward=spawn(executable('ssh'),[...sshArgs(state,sshPort,'control',['-N','-o','ExitOnForwardFailure=yes',
    '-R',`127.0.0.1:13128:127.0.0.1:${egress.proxyPort}`,'-R',`127.0.0.1:18080:127.0.0.1:${egress.apiPort}`])],
    {env:cleanEnv(),shell:false,windowsHide:true,stdio:['ignore','ignore',log]});
  forward.on('exit',()=>{if(!closing){ready=false;phase='egress_disconnected';egress.close();record();}});
  forward.on('error',()=>{if(!closing){ready=false;phase='egress_disconnected';egress.close();record();}});
  const payload=JSON.stringify({capability:egress.capability,model:settings.model||null});
  const installed=await guest(state,sshPort,"sudo python3 -c 'import sys,pathlib; p=pathlib.Path(\"/opt/starport/connection.json\"); p.write_text(sys.stdin.read()); p.chmod(0o644)'",{user:'control',input:payload});
  if(installed.code!==0)throw new Error('guest_configuration_failed');
  await sleep(500);if(forward.exitCode!==null)throw new Error('egress_tunnel_failed');
  ready=true;phase='ready';record();note({phase});
}catch(e){lastError=/^[a-z_]+$/.test(e.message)?e.message:'runtime_failed';note({error:lastError});await shutdown();}
process.on('SIGTERM',()=>void shutdown());process.on('SIGINT',()=>void shutdown());
