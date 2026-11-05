#!/usr/bin/env node
import path from 'node:path';import {spawn} from 'node:child_process';import {fileURLToPath} from 'node:url';
import {createInstaller} from './installation.mjs';import {serveInstaller} from './server.mjs';import {defaultTarget} from './plan.mjs';import {payload,installation} from './owned-files.mjs';import {copyManager,cleanupManager} from './manager-copy.mjs';import {startControl,paths} from './driver.mjs';
const args=process.argv.slice(2),o={};while(args.length){const k=args.shift();if(['--start','--uninstall','--check','--no-open'].includes(k))o[k]=true;else if(['--source','--target','--port','--runner-copy'].includes(k)&&args.length)o[k]=args.shift();else throw Error('invalid_installer_arguments');}
const source=path.resolve(o['--source']||fileURLToPath(new URL('../../../',import.meta.url))),root=path.resolve(o['--target']||defaultTarget()),runner=path.resolve(fileURLToPath(new URL('../../../',import.meta.url)));
function open(url){const app=process.platform==='win32'?'rundll32.exe':'xdg-open',argv=process.platform==='win32'?['url.dll,FileProtocolHandler',url]:[url];const child=spawn(app,argv,{shell:false,windowsHide:true,stdio:'ignore',detached:true});child.on('error',()=>console.log('browser_open_failed_use_local_installer'));child.unref();}
try{
 if(o['--check']){const m=await payload(source);console.log(JSON.stringify({verified:true,version:m.version,platform:m.platform,files:m.files.length}));}
 else if(o['--start']&&installation(root)?.phase==='installed'){
  const client=await startControl(root),p=paths(root);open(client.origin);
  const child=process.platform==='win32'?spawn('powershell.exe',['-NoProfile','-STA','-ExecutionPolicy','Bypass','-File',path.join(p.app,'scripts/show-access-code.ps1'),'-State',p.state],{stdio:'ignore',detached:true,windowsHide:true}):spawn(p.node,[path.join(p.app,'scripts/linux-open.mjs'),'--state',p.state,'--app','access'],{stdio:'ignore',detached:true});child.on('error',()=>{});child.unref();
 }else if(source===root&&!o['--runner-copy']){
  const copy=await copyManager(root),node=path.join(copy.dir,'runtime',process.platform==='win32'?'node.exe':'bin/node');
  const child=spawn(node,[path.join(copy.dir,'app/packages/installer/cli.mjs'),'--source',root,'--target',root,'--runner-copy',copy.nonce,...(o['--uninstall']?['--uninstall']:[])],{stdio:'ignore',detached:true,windowsHide:true});child.on('error',()=>cleanupManager(copy.dir,copy.nonce));child.unref();
 }else{
  const manager=createInstaller({source,root});let cleaned=false;const cleanup=()=>{if(!cleaned&&o['--runner-copy']){cleaned=true;cleanupManager(runner,o['--runner-copy']);}};
  const service=await serveInstaller(manager,{port:Number(o['--port']||0),onExit:cleanup});
  console.log('Starport Next installation wizard: '+service.origin);
  // The fragment is consumed locally and never sent in HTTP requests or logs.
  if(!o['--no-open'])open(service.launchUrl+(o['--uninstall']?'?uninstall':''));
  process.on('SIGINT',()=>{if(!manager.snapshot().running){service.close();cleanup();}});process.on('SIGTERM',()=>{if(!manager.snapshot().running){service.close();cleanup();}});
 }
}catch(e){console.error(JSON.stringify({error:e.code||'installer_start_failed'}));process.exitCode=1;}
