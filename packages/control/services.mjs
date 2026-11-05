import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {error,read,run,cleanEnv} from '../runtime/common.mjs';
import {createLinuxServices} from './linux-services.mjs';

const script=fileURLToPath(new URL('../../scripts/register-startup.ps1',import.meta.url));
export function createServices(state,configurationFile,{platform=process.platform,execute=run}={}) {
  if(platform==='linux')return createLinuxServices(state,configurationFile,{execute});
  let cached,updated=0,busy=false;
  async function registration(action='status') {
    if(platform!=='win32'||!configurationFile)throw error('local_windows_installation_required');
    const r=await execute('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,
      '-Action',action,'-State',state,'-Config',configurationFile,'-Node',process.execPath],{
      timeout:20000,maxBytes:65536,env:cleanEnv(Object.fromEntries(['USERPROFILE','APPDATA','LOCALAPPDATA'].filter(k=>process.env[k]).map(k=>[k,process.env[k]])))
    });
    if(r.code!==0)throw error('service_registration_failed');
    const v=JSON.parse(r.stdout);
    cached={registered:v.registered===true,enabled:v.enabled===true,kind:'current-user-login'};updated=Date.now();return cached;
  }
  return {
    async status(){
      if(platform!=='win32'||!configurationFile)return {supported:false};
      let registrationError;
      if(!cached||Date.now()-updated>15000){try{await registration();}catch{registrationError='service_registration_unavailable';}}
      let receipt;try{receipt=read(path.join(state,'services.json'));}catch{}
      const fresh=receipt?.format==='starport-user-services-status'&&Date.now()-Date.parse(receipt.checkedAt)<45000;
      return {supported:true,startup:cached||{registered:false,enabled:false,kind:'current-user-login'},
        ...(registrationError?{error:registrationError}:{}),
        supervisor:{phase:fresh?'running':'stopped',checkedAt:receipt?.checkedAt||null},
        services:(Array.isArray(receipt?.services)?receipt.services:[]).filter(s=>['control','compute'].includes(s.id)||/^compute-[a-z][a-z0-9-]{0,47}$/.test(s.id)).map(s=>({id:s.id,phase:fresh?s.phase:'unknown',error:s.error||null}))};
    },
    async action(action){
      if(!['enable','disable','start'].includes(action))throw error('invalid_service_action');
      if(busy)throw error('service_operation_pending');busy=true;
      try{await registration(action);if(action==='enable')await registration('start');return {accepted:true,action,startup:cached};}
      finally{busy=false;}
    }
  };
}
