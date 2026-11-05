import fs from 'node:fs';import http from 'node:http';import crypto from 'node:crypto';import path from 'node:path';
import {error,read} from '../runtime/common.mjs';import {parseSubscription,fetchSubscription} from './subscription.mjs';import {paths,startControl} from './driver.mjs';
const equal=(a,b)=>typeof a==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&crypto.timingSafeEqual(Buffer.from(a),Buffer.from(b));
async function body(req,max=3*1024*1024){const parts=[];let size=0;for await(const b of req){size+=b.length;if(size>max)throw error('request_too_large');parts.push(b);}try{return JSON.parse(Buffer.concat(parts));}catch{throw error('invalid_json');}}
export async function serveInstaller(manager,{port=0,onExit=()=>{}}={}){
  const token=crypto.randomBytes(32).toString('hex'),cookie=crypto.randomBytes(32).toString('hex');
  const assets=Object.fromEntries(['index.html','app.js','style.css'].map(name=>[name,fs.readFileSync(new URL('./web/'+name,import.meta.url))]));
  let origin;
  const server=http.createServer(async(req,res)=>{
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('Cache-Control','no-store');
    const json=(code,value)=>{res.writeHead(code,{'content-type':'application/json; charset=utf-8'});res.end(JSON.stringify(value));};
    try{
      if(!['127.0.0.1','::ffff:127.0.0.1'].includes(req.socket.remoteAddress)||req.headers.host!==new URL(origin).host||req.headers['x-forwarded-for']||req.headers['cf-access-jwt-assertion'])throw error('local_installer_only');
      const route=new URL(req.url,origin).pathname;
      if(req.method==='GET'&&['/','/app.js','/style.css'].includes(route)){const name=route==='/'?'index.html':route.slice(1);res.writeHead(200,{'content-type':name.endsWith('.html')?'text/html; charset=utf-8':name.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8'});res.end(assets[name]);return;}
      if(route==='/api/login'&&req.method==='POST'){
        if(req.headers.origin!==origin)throw error('origin_denied');const b=await body(req,4096);if(!equal(b.token,token))throw error('authentication_required');res.setHeader('Set-Cookie',`starport_setup=${cookie}; HttpOnly; SameSite=Strict; Path=/`);return json(200,{csrf:token});
      }
      if(!String(req.headers.cookie||'').split(';').map(v=>v.trim()).includes('starport_setup='+cookie))throw error('authentication_required');
      if(req.method!=='GET'&&(req.headers.origin!==origin||!equal(req.headers['x-setup-csrf'],token)))throw error('csrf_failed');
      if(route==='/api/state'&&req.method==='GET')return json(200,manager.snapshot());
      if(route==='/api/network'&&req.method==='POST'){const b=await body(req);const subscription=b.text?parseSubscription(b.text):await fetchSubscription(b.url);return json(200,{nodes:manager.network(subscription)});}
      if(route==='/api/apply'&&req.method==='POST'){const input=await body(req);if(manager.snapshot().running)throw error('installation_busy');const result=manager.apply(input);result.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));if(!manager.snapshot().running)await result;return json(202,{accepted:true});}
      if(route==='/api/uninstall'&&req.method==='POST'){const input=await body(req,4096);if(manager.snapshot().running)throw error('installation_busy');const result=manager.uninstall(input);result.catch(()=>{});await new Promise(resolve=>setImmediate(resolve));if(!manager.snapshot().running)await result;return json(202,{accepted:true});}
      if(route==='/api/panel'&&req.method==='POST'){await body(req,1024);if(manager.snapshot().running||!manager.snapshot().installed)throw error('installation_not_ready');const client=await startControl(manager.root);const p=paths(manager.root);return json(200,{url:client.origin,key:read(path.join(p.state,'panel-key.json')).key});}
      if(route==='/api/exit'&&req.method==='POST'){await body(req,1024);if(manager.snapshot().running)throw error('installation_busy');json(200,{closed:true});setImmediate(()=>{server.closeAllConnections();server.close();onExit();});return;}
      throw error('unknown_route');
    }catch(e){json(400,{error:/^[a-z][a-z0-9_]{1,100}$/.test(e.code||'')?e.code:'installer_request_failed'});}
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});origin='http://127.0.0.1:'+server.address().port;
  return {origin,launchUrl:origin+'/#'+token,close:()=>{server.closeAllConnections();server.close();}};
}
