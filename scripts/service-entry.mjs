#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {read,sleep,error} from '../packages/runtime/common.mjs';
import {ensureProjectVm} from '../packages/runtime/qemu-project.mjs';
import {control} from '../packages/runtime/control.mjs';

const args=process.argv.slice(2),options={};
while(args.length){const key=args.shift(),value=args.shift();if(!['--kind','--state','--config'].includes(key)||!value||key in options)throw error('invalid_service_arguments');options[key]=value;}
const kind=options['--kind'],state=path.resolve(options['--state']),config=path.resolve(options['--config']);
const repo=fileURLToPath(new URL('../',import.meta.url));
if(kind==='vm'){
  await ensureProjectVm(state);let closing=false;
  const stop=async()=>{if(closing)return;closing=true;await control(state,'/stop','POST');for(let n=0;n<180;n++){if(!(await control(state)).running)return;await sleep(250);}throw error('guest_shutdown_not_confirmed');};
  process.on('SIGTERM',()=>void stop().catch(()=>{process.exitCode=1;}));process.on('SIGINT',()=>void stop().catch(()=>{process.exitCode=1;}));
  while(!closing){await sleep(1000);if(!(await control(state)).running)throw error('owned_vm_stopped');}
}else if(kind==='control'){
  const lock=path.join(state,'control.lock');
  if(fs.existsSync(lock)){
    const st=fs.lstatSync(lock),value=read(lock);
    if(st.isSymbolicLink()||st.uid!==process.getuid()||!Number.isInteger(value.pid))throw error('control_lock_requires_reconciliation');
    const boot=fs.readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
    let alive=false;try{process.kill(value.pid,0);alive=true;}catch{}
    if(alive&&(!value.bootId||value.bootId===boot))throw error('control_already_started_or_requires_reconciliation');
    fs.unlinkSync(lock);
  }
  const c=read(config);process.argv=[process.execPath,path.join(repo,'bin/starport.mjs'),'control','serve','--state',state,'--config',config,'--client',c.apiKeyFile?'api':'native'];
  await import(pathToFileURL(process.argv[1]));
}else if(kind==='compute'){
  process.argv=[process.execPath,path.join(repo,'scripts/start-worker-compute.mjs'),'--config',config];await import(pathToFileURL(process.argv[1]));
}else throw error('invalid_service_kind');
