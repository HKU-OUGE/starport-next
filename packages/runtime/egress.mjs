import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { error } from './common.mjs';

export const DEFAULT_HOSTS=['api.anthropic.com','registry.npmjs.org','nodejs.org','github.com','objects.githubusercontent.com','raw.githubusercontent.com','example.com'];
export function authority(value,hosts) {
  const match=/^([a-z0-9.-]+):443$/i.exec(value||'');
  if(!match||net.isIP(match[1])||!hosts.includes(match[1].toLowerCase()))throw error('destination_not_allowed');
  return match[1].toLowerCase();
}
export function validateUpstream(value) {
  if(!value||typeof value!=='object')throw error('controlled_proxy_required');
  if(value.kind==='unix'&&typeof value.path==='string'&&value.path.startsWith('/')&&!value.path.includes('\0'))return value;
  if(value.kind==='http'){
    const u=new URL(value.url);
    if(u.protocol==='http:'&&u.hostname==='127.0.0.1'&&u.port&&u.pathname==='/'&&!u.username&&!u.password&&!u.search&&!u.hash)return value;
  }
  throw error('loopback_proxy_or_unix_socket_required');
}
export function throughProxy(upstream,host,port=443) {
  validateUpstream(upstream);
  return new Promise((resolve,reject)=>{
    const u=upstream.kind==='http'?new URL(upstream.url):null;
    const socket=upstream.kind==='unix'?net.connect(upstream.path):net.connect(Number(u.port),'127.0.0.1');
    let buffer=Buffer.alloc(0),done=false;
    const timer=setTimeout(()=>finish(error('controlled_proxy_timeout')),15000);
    const finish=(err)=>{if(done)return;done=true;clearTimeout(timer);socket.removeListener('data',data);socket.removeListener('error',failed);
      if(err){socket.destroy();reject(err);}else{socket.on('error',()=>{});resolve(socket);}};
    const failed=()=>finish(error('controlled_proxy_unavailable'));
    const data=part=>{
      buffer=Buffer.concat([buffer,part]);const end=buffer.indexOf('\r\n\r\n');
      if(end<0){if(buffer.length>16384)finish(error('proxy_header_limit'));return;}
      if(!/^HTTP\/1\.[01] 200(?: |\r)/.test(buffer.toString('ascii',0,end)))return finish(error('controlled_proxy_rejected'));
      socket.pause();if(buffer.length>end+4)socket.unshift(buffer.subarray(end+4));finish();
    };
    socket.once('error',failed);socket.on('data',data);
    socket.once('connect',()=>socket.write(`CONNECT ${host}:${port} HTTP/1.1\r\nHost: ${host}:${port}\r\n\r\n`));
  });
}
function equal(a,b){const x=Buffer.from(a||''),y=Buffer.from(b||'');return x.length===y.length&&crypto.timingSafeEqual(x,y);}
const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve(server.address().port));});

export async function fetchThroughProxy(url,upstream,{headers={}}={}) {
  const u=new URL(url);if(u.protocol!=='https:'||u.port&&u.port!=='443'||u.username||u.password)throw error('https_download_required');
  const tunnel=await throughProxy(upstream,u.hostname);const socket=tls.connect({socket:tunnel,servername:u.hostname,rejectUnauthorized:true});socket.resume();
  await new Promise((resolve,reject)=>{socket.once('secureConnect',resolve);socket.once('error',reject);});
  const agent=new https.Agent({keepAlive:false});agent.createConnection=(_o,callback)=>callback(null,socket);
  return new Promise((resolve,reject)=>{
    const req=https.get(u,{agent,headers},res=>{res.on('end',()=>agent.destroy());res.on('error',()=>agent.destroy());resolve(res);});
    req.setTimeout(120000,()=>req.destroy(error('download_timeout')));req.on('error',e=>{agent.destroy();reject(e);});
  });
}

export async function createEgress({upstream,hosts=DEFAULT_HOSTS,apiKey,model,capability=crypto.randomBytes(32).toString('hex')}) {
  validateUpstream(upstream);
  if(!Array.isArray(hosts)||hosts.length>128||hosts.some(h=>typeof h!=='string'||!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(h)||h.endsWith('.local')))throw error('invalid_egress_allowlist');
  let enabled=true,requests=0;const connections=new Set();
  const track=socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket));socket.on('error',()=>{});return socket;};
  const proxy=http.createServer((_req,res)=>{res.writeHead(403);res.end('HTTPS CONNECT required');});
  proxy.on('connection',track);
  proxy.on('connect',async(req,client,head)=>{
    try{
      if(!enabled)throw error('egress_paused');const host=authority(req.url,hosts);
      const remote=track(await throughProxy(upstream,host));
      if(!enabled){remote.destroy();throw error('egress_paused');}
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if(head.length)remote.write(head);remote.pipe(client);client.pipe(remote);remote.resume();
      client.on('close',()=>remote.destroy());remote.on('close',()=>client.destroy());
    }catch{if(!client.destroyed)client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\ncontrolled_egress_unavailable');}
  });
  const api=http.createServer(async(req,res)=>{
    const cap=req.headers['x-api-key']||(req.headers.authorization||'').replace(/^Bearer /,'');
    if(!equal(cap,capability)){res.writeHead(401);res.end('{"error":"workspace_token_required"}');return;}
    if(!enabled||!apiKey){res.writeHead(503);res.end('{"error":"model_egress_unavailable"}');return;}
    const url=new URL(req.url,'http://workspace.invalid');
    if(![['POST','/v1/messages'],['POST','/v1/messages/count_tokens'],['GET','/v1/models']].some(([m,p])=>m===req.method&&p===url.pathname)){
      res.writeHead(403);res.end('{"error":"api_route_not_allowed"}');return;
    }
    let body=Buffer.alloc(0),remote;
    try{
      for await(const part of req){body=Buffer.concat([body,part]);if(body.length>16*1024*1024)throw error('request_too_large');}
      if(req.method==='POST'){
        const value=JSON.parse(body);if(model&&value.model!==model)throw error('model_not_allowed');
      }
      if(requests>=1000)throw error('gateway_request_budget_exceeded');requests++;
      const tunnel=track(await throughProxy(upstream,'api.anthropic.com'));
      if(!enabled){tunnel.destroy();throw error('egress_paused');}
      remote=track(tls.connect({socket:tunnel,servername:'api.anthropic.com',rejectUnauthorized:true}));remote.resume();
      await new Promise((resolve,reject)=>{remote.once('secureConnect',resolve);remote.once('error',reject);});
      const headers={'x-api-key':apiKey,'anthropic-version':req.headers['anthropic-version']||'2023-06-01','content-type':'application/json','content-length':body.length};
      // Preserve SDK product identity. Do not send browser, host, proxy, or Access identity headers.
      for(const k of ['anthropic-beta','user-agent','accept','x-app','x-stainless-lang','x-stainless-package-version','x-stainless-os','x-stainless-arch','x-stainless-runtime','x-stainless-runtime-version','x-stainless-retry-count'])
        if(typeof req.headers[k]==='string')headers[k]=req.headers[k];
      const agent=new https.Agent({keepAlive:false});agent.createConnection=(_options,callback)=>{callback(null,remote);};
      const outgoing=https.request({host:'api.anthropic.com',port:443,method:req.method,path:url.pathname+url.search,headers,agent},incoming=>{
        res.writeHead(incoming.statusCode,{'content-type':incoming.headers['content-type']||'application/json','cache-control':'no-store'});
        incoming.pipe(res);incoming.on('end',()=>agent.destroy());
      });
      outgoing.on('error',()=>{if(!res.headersSent)res.writeHead(502);res.end('{"error":"model_upstream_unavailable"}');agent.destroy();});
      res.on('close',()=>{outgoing.destroy();agent.destroy();});outgoing.end(body);
    }catch(e){remote?.destroy();if(!res.headersSent)res.writeHead(e.code==='model_not_allowed'?403:502);res.end('{"error":"model_gateway_request_failed"}');}
  });
  api.on('connection',track);
  const proxyPort=await listen(proxy),apiPort=await listen(api);
  return {proxyPort,apiPort,capability,get enabled(){return enabled;},get requests(){return requests;},modelReady:Boolean(apiKey),
    pause(){enabled=false;for(const c of connections)c.destroy();},resume(){enabled=true;},
    close(){enabled=false;for(const c of connections)c.destroy();proxy.close();api.close();}};
}
