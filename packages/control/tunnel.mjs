import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { executable,cleanEnv,writePrivate,error } from '../runtime/common.mjs';
import { validateAccess } from './access.mjs';

export function tunnelArgs(configFile,tokenFile){return ['tunnel','--config',configFile,'--no-autoupdate','--loglevel','error','run','--token-file',tokenFile];}
export function startTunnel(state,settings,access,{spawnProcess=spawn}={}){
  if(!validateAccess(access))throw error('access_required_before_tunnel');
  const binary=settings.binary||executable('cloudflared');if(!binary)throw error('cloudflared_binary_required');
  const st=fs.lstatSync(settings.tokenFile);
  if(st.isSymbolicLink()||!st.isFile()||st.size>65536||process.platform!=='win32'&&(st.mode&0o077))throw error('private_tunnel_token_file_required');
  const configFile=path.join(state,'cloudflared.yml');writePrivate(configFile,'# Remotely managed; do not inherit another installation.\n');
  let phase='starting';
  const child=spawnProcess(binary,tunnelArgs(configFile,settings.tokenFile),{shell:false,windowsHide:true,env:cleanEnv(),stdio:'ignore'});
  child.on('spawn',()=>{phase='process-running';});child.on('error',()=>{phase='failed';});child.on('exit',()=>{if(phase!=='stopped')phase='exited';});
  return {status:()=>({phase,publicAccessVerified:false}),close(){phase='stopped';child.kill();}};
}
