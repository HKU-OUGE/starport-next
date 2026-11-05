#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {launchLocalClient} from '../packages/control/client-launcher.mjs';
const args=process.argv.slice(2),o={};
try{
  while(args.length){const k=args.shift(),v=args.shift();if(!['--state','--workspace','--app'].includes(k)||!v||k in o)throw Error('invalid_arguments');o[k]=v;}
  const state=path.resolve(o['--state']),workspace=o['--workspace']||'main',app=o['--app'];
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw Error('invalid_workspace');
  if(app==='panel'){
    const r=JSON.parse(fs.readFileSync(path.join(state,'control.json'),'utf8'));if(r.phase!=='running'||!Number.isInteger(r.port)||r.port<1024||r.port>65535)throw Error('control_not_running');
    spawn('xdg-open',['http://127.0.0.1:'+r.port+'/?workspace='+workspace+'#clients'],{stdio:'ignore'}).on('error',()=>{process.exitCode=1;});
  }else if(app==='access'){
    const value=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'),'utf8')).key;if(!/^[a-f0-9]{64}$/.test(value))throw Error('invalid_panel_key');
    // Code travels over stdin only; no clipboard, argv, URL or terminal logging.
    const child=spawn('zenity',['--text-info','--title=Starport · 本机访问码','--width=620','--height=180'],{stdio:['pipe','ignore','ignore']});
    child.on('error',()=>{process.exitCode=1;});child.stdin.on('error',()=>{});child.stdin.end(value+'\n');
  }else await launchLocalClient({state,workspace,app,display:'seamless'});
}catch(e){
  const code=/^[a-z_]{1,100}$/.test(e.message)?e.message:'client_launch_failed';
  const child=spawn('zenity',['--error','--title=Starport','--text='+code],{stdio:'ignore'});child.on('error',()=>{});process.stderr.write(code+'\n');process.exitCode=1;
}
