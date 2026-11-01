// Derived from Starport Pi's operator Access boundary. MIT, Starport contributors.
import crypto from 'node:crypto';
import { createRemoteJWKSet,jwtVerify } from 'jose';
import { error } from '../runtime/common.mjs';
const same=(a,b)=>{const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);};
export function validateAccess(c){
  if(c===undefined)return null;
  if(!/^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/.test(c.issuer||'')||typeof c.hostname!=='string'||c.hostname.length>253||!/^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(c.hostname)||typeof c.audience!=='string'||!c.audience||c.audience.length>512||/[\x00-\x20]/.test(c.audience)||!Array.isArray(c.allowedEmails)||!c.allowedEmails.length||c.allowedEmails.length>100||c.allowedEmails.some(e=>typeof e!=='string'||e.length>254||!/^[^\s@*]+@[^\s@*]+\.[^\s@*]+$/.test(e)))throw error('invalid_access_configuration');
  return c;
}
export async function verifyAccess(token,c,{keySet}={}){
  if(typeof token!=='string'||token.length>16384)throw error('access_authentication_required');
  const {payload}=await jwtVerify(token,keySet||createRemoteJWKSet(new URL(c.issuer+'/cdn-cgi/access/certs')),
    {issuer:c.issuer,audience:c.audience,algorithms:['RS256'],requiredClaims:['exp','iat','sub','email'],clockTolerance:5});
  if(typeof payload.email!=='string'||!c.allowedEmails.some(e=>e.toLowerCase()===payload.email.toLowerCase()))throw error('access_denied');
  return payload.sub;
}
export function createAccess({port,key,access,keySet}){
  const c=validateAccess(access),jwks=keySet||(c?createRemoteJWKSet(new URL(c.issuer+'/cdn-cgi/access/certs'),{timeoutDuration:5000}):null);
  const cookie=crypto.createHmac('sha256',key).update('operator-session').digest('hex');
  return {cookie,
    login:input=>same(input,key),
    policy(req){
      const host=req.headers.host;
      if(['127.0.0.1:'+port,'localhost:'+port].includes(host)){
        if(!['127.0.0.1','::ffff:127.0.0.1','::1'].includes(req.socket.remoteAddress)||Object.keys(req.headers).some(k=>k==='forwarded'||k==='via'||k==='true-client-ip'||k.startsWith('cf-')||k.startsWith('x-forwarded-')))throw error('local_access_denied');
        return {mode:'local',origin:'http://'+host};
      }
      if(c&&host===c.hostname)return {mode:'cloudflare',origin:'https://'+c.hostname};
      throw error('host_not_allowed');
    },
    async authenticate(req,policy){
      if(policy.mode==='cloudflare')return verifyAccess(req.headers['cf-access-jwt-assertion'],c,{keySet:jwks});
      if(!String(req.headers.cookie||'').split(';').some(v=>same(v.trim(),'starport_control='+cookie)))throw error('authentication_required');
      return 'local-operator';
    },
    csrf:identity=>crypto.createHmac('sha256',key).update('csrf:'+identity).digest('hex'),
    check(req,policy,identity){if(req.headers.origin!==policy.origin||!same(req.headers['x-csrf-token'],this.csrf(identity)))throw error('origin_or_csrf_denied');}
  };
}
