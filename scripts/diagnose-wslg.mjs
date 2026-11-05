#!/usr/bin/env node
// Operator-only, read-only, no network requests and no changes to WSL or Chrome.
import fs from 'node:fs';
import path from 'node:path';
import {run,executable,privateDir,read} from '../packages/runtime/common.mjs';
import {wslArgs} from '../packages/wsl/runtime.mjs';
try{
  const args=process.argv.slice(2),o={};
  while(args.length){const key=args.shift(),value=args.shift();if(!['--state','--workspace','--watch','--output'].includes(key)||!value||key in o)throw Error('invalid_arguments');o[key]=value;}
  if(process.platform!=='win32')throw Error('wsl_diagnostic_requires_windows');
  const workspace=o['--workspace']||'main',seconds=Number(o['--watch']||0);
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace)||!Number.isInteger(seconds)||seconds<0||seconds>3600)throw Error('invalid_arguments');
  const state=path.resolve(o['--state']||'private/wsl'),receipt=read(path.join(state,'wsl.json'));
  const argv=wslArgs(receipt.distribution,'/usr/bin/python3','-I','-c',fs.readFileSync(new URL('../packages/wsl/display-diagnostic.py',import.meta.url),'utf8'));
  if(!/^[a-f0-9]{64}$/.test(receipt.owner||''))throw Error('owned_wsl_required');
  const wsl=executable('wsl');if(!wsl)throw Error('wsl_not_installed');
  // Query running distributions first. A diagnostic must not boot a stopped VM.
  const running=await run(wsl,['--list','--running','--quiet'],{timeout:10000,maxBytes:65536});
  if(running.code!==0)throw Error('wsl_status_unavailable');
  if(!running.stdout.replaceAll('\0','').split(/\r?\n/).map(s=>s.trim()).includes(receipt.distribution))throw Error('owned_wsl_not_running');
  const output=o['--output']?path.resolve(o['--output']):null;
  if(output){privateDir(path.dirname(output));fs.writeFileSync(output,'',{flag:'wx',mode:0o600});}
  const end=Date.now()+seconds*1000;let prior=null;
  do{
    const result=await run(wsl,argv,{input:JSON.stringify({workspace,owner:receipt.owner})+'\n',timeout:20000,maxBytes:65536});
    if(result.code!==0)throw Error('display_diagnostic_failed');
    const current=JSON.parse(result.stdout);
    const same=prior&&JSON.stringify(prior.browsers)===JSON.stringify(current.browsers);
    const report={checkedAt:new Date().toISOString(),...current,browserProcessUnchanged:prior?!!same:null};
    const line=JSON.stringify(report)+'\n';process.stdout.write(line);if(output)fs.appendFileSync(output,line,{encoding:'utf8'});
    prior=current;if(Date.now()>=end)break;await new Promise(resolve=>setTimeout(resolve,5000));
  }while(true);
}catch(e){console.error(JSON.stringify({ok:false,error:/^[a-z_]+$/.test(e.message)?e.message:'display_diagnostic_failed'}));process.exitCode=1;}
