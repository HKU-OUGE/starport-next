import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {pipeBridge} from '../control/pipe-bridge.mjs';
import {cleanEnv,error} from '../runtime/common.mjs';
import {wslArgs} from './runtime.mjs';

export function runInstaller(receipt,script,request,proxyPort){
  const relay=fs.readFileSync(new URL('./installer-relay.py',import.meta.url),'utf8');
  const child=spawn('wsl.exe',wslArgs(receipt.distribution,'/usr/bin/python3','-I','-c',relay),{windowsHide:true,env:cleanEnv({WSLENV:''}),stdio:['pipe','pipe','pipe']});
  return new Promise((resolve,reject)=>{
    let stdout='',done=false,bridge;
    const finish=(err,code)=>{if(done)return;done=true;clearTimeout(timer);bridge?.close();err?reject(err):resolve({code,stdout,stderr:''});};
    const timer=setTimeout(()=>{bridge?.close();child.kill();finish(error('installer_timeout'));},1800000);
    bridge=pipeBridge(child,{proxy:proxyPort},{onEvent:frame=>{
      if(frame.type==='output')stdout=(stdout+Buffer.from(frame.data,'base64').toString('utf8')).slice(-128*1024);
      if(frame.type==='exit')finish(null,frame.code);
      if(['failure','disconnected'].includes(frame.type))finish(error('installer_disconnected'));
    }});
    child.stdin.write(JSON.stringify({owner:receipt.owner,script,request})+'\n');
  });
}
