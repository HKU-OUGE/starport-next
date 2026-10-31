import fs from 'node:fs';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { executable,cleanEnv,error,sleep } from '../runtime/common.mjs';

export function computeSshArgs(c,localPort,platform=process.platform){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9.-]{0,252}$/.test(c.host||'')||!/^[_a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(c.user||'')||
    ![c.port||22,c.serverPort,localPort].every(p=>Number.isInteger(p)&&p>0&&p<=65535)||!c.identityFile||!c.knownHostsFile)
    throw error('invalid_compute_ssh_configuration');
  const knownHosts=String(c.knownHostsFile).replaceAll('\\','/').replaceAll('"','\\"').replaceAll('%','%%');
  if(/[\x00-\x1f]/.test(c.identityFile+knownHosts))throw error('invalid_compute_ssh_configuration');
  return ['-F',platform==='win32'?'NUL':'/dev/null','-NT','-p',String(c.port||22),'-i',c.identityFile,
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','ForwardAgent=no','-o','SendEnv=-*',
    '-o','StrictHostKeyChecking=yes','-o',`UserKnownHostsFile="${knownHosts}"`,'-o','GlobalKnownHostsFile=none',
    '-o','ExitOnForwardFailure=yes','-o','ConnectTimeout=12','-o','ServerAliveInterval=20','-o','ServerAliveCountMax=3',
    '-L',`127.0.0.1:${localPort}:127.0.0.1:${c.serverPort}`,`${c.user}@${c.host}`];
}
export async function startComputeSsh(c){
  for(const file of [c.identityFile,c.knownHostsFile]){const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile())throw error('compute_ssh_material_required');}
  const binary=executable('ssh');if(!binary)throw error('openssh_client_required');
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const port=s.address().port;s.close(()=>resolve(port));});});
  const child=spawn(binary,computeSshArgs(c,port),{shell:false,windowsHide:true,env:cleanEnv(),stdio:'ignore'});let failed=false;
  child.on('error',()=>{failed=true;});
  for(let i=0;i<150;i++){
    if(failed||child.exitCode!==null){child.kill();throw error('compute_ssh_unavailable');}
    const open=await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});
    if(open)return {url:`http://127.0.0.1:${port}`,close:()=>child.kill()};
    await sleep(100);
  }
  child.kill();throw error('compute_ssh_timeout');
}
