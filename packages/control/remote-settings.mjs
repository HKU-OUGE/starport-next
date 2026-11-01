import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import {privateDir,writePrivate,error} from '../runtime/common.mjs';
import {relative} from '../config/model.mjs';
import {validateAccess} from './access.mjs';

const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function remoteInput(value){
  const fields=['revision','enabled','hostname','issuer','audience','allowedEmails','tunnelEnabled','tunnelToken'];
  if(!value||Array.isArray(value)||Object.keys(value).some(k=>!fields.includes(k))||typeof value.enabled!=='boolean')throw error('invalid_remote_settings');
  if(!value.enabled)return {enabled:false};
  if(typeof value.tunnelEnabled!=='boolean')throw error('invalid_remote_settings');
  const access={hostname:String(value.hostname||'').trim().toLowerCase(),issuer:String(value.issuer||'').trim().replace(/\/$/,''),audience:String(value.audience||'').trim(),
    allowedEmails:Array.isArray(value.allowedEmails)?[...new Set(value.allowedEmails.map(e=>typeof e==='string'?e.trim().toLowerCase():e))].sort():[]};
  validateAccess(access);
  if(value.tunnelToken!==undefined&&(typeof value.tunnelToken!=='string'||value.tunnelToken.length>65536||/[\x00-\x20]/.test(value.tunnelToken)||value.tunnelToken.length>0&&value.tunnelToken.length<32))throw error('invalid_tunnel_token');
  return {enabled:true,access,tunnelEnabled:value.tunnelEnabled,token:value.tunnelToken||null};
}
export function createRemoteSettings(file,{activate=async()=>{},active=()=>({enabled:false,tunnel:{phase:'not-configured'}}),port=()=>0}={}){
  let busy=false;
  function current(){
    if(!file)throw error('remote_settings_configuration_required');
    const st=fs.lstatSync(file);if(st.isSymbolicLink()||!st.isFile()||st.size>1024*1024)throw error('invalid_control_configuration');
    const bytes=fs.readFileSync(file),config=JSON.parse(bytes);
    if(config.format!=='starport-host-control'||config.version!==1)throw error('invalid_control_configuration');
    return {bytes,config,revision:digest(bytes)};
  }
  function tokenExists(c){
    if(!c.tunnel?.tokenFile||!relative(c.tunnel.tokenFile))return false;
    try{const st=fs.lstatSync(path.resolve(path.dirname(file),c.tunnel.tokenFile));return st.isFile()&&!st.isSymbolicLink();}catch{return false;}
  }
  const snapshot=()=>{
    if(!file)return {supported:false};
    const {config,revision}=current();
    return {supported:true,revision,enabled:!!config.access,hostname:config.access?.hostname||'',issuer:config.access?.issuer||'',audience:config.access?.audience||'',
      allowedEmails:config.access?.allowedEmails||[],tunnelEnabled:!!config.tunnel,tokenPresent:tokenExists(config),active:active(),publicAccessVerified:false};
  };
  return {snapshot,
    async save(value){
      if(busy)throw error('remote_settings_busy');busy=true;let newToken;
      try{
        const before=current();if(value?.revision!==before.revision)throw error('remote_settings_changed_reload');
        const input=remoteInput(value),next=structuredClone(before.config),base=path.dirname(path.resolve(file));
        const storage=privateDir(path.join(base,'.starport-remote'));
        if(input.enabled){
          next.access=input.access;
          if(input.tunnelEnabled){
            let tokenFile=before.config.tunnel?.tokenFile;
            if(input.token){newToken=path.join(storage,'token-'+crypto.randomBytes(12).toString('hex')+'.txt');writePrivate(newToken,input.token);tokenFile=path.relative(base,newToken).replaceAll('\\','/');}
            if(!tokenFile||!relative(tokenFile)||!fs.existsSync(path.resolve(base,tokenFile)))throw error('tunnel_token_required');
            next.tunnel={...(before.config.tunnel||{}),tokenFile};
          }else delete next.tunnel;
        }else{delete next.access;delete next.tunnel;}
        // Keep one exact prior version per operation, including unrelated config.
        writePrivate(path.join(storage,'before-'+crypto.randomBytes(8).toString('hex')+'.json'),before.bytes.toString('utf8'));
        if(digest(fs.readFileSync(file))!==before.revision)throw error('remote_settings_changed_reload');
        writePrivate(file,next);
        try{await activate(next);}catch(e){writePrivate(file,before.bytes.toString('utf8'));throw e;}
        return {...snapshot(),applied:true};
      }catch(e){if(newToken)fs.rmSync(newToken,{force:true});throw e;}
      finally{busy=false;}
    },
    async check(){
      const s=active();if(!s.enabled||!s.hostname)throw error('remote_access_not_enabled');
      const result=await new Promise((resolve,reject)=>{
        const req=http.get({host:'127.0.0.1',port:port(),path:'/api/status',headers:{Host:s.hostname},timeout:5000},res=>{res.resume();resolve({status:res.statusCode});});
        req.on('timeout',()=>req.destroy());req.on('error',()=>reject(error('remote_origin_check_failed')));
      });
      return {originRejectsUnauthenticated:result.status===403,publicAccessVerified:false,checkedAt:new Date().toISOString()};
    }
  };
}
