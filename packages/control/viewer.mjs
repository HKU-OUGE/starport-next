import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WebSocketServer,createWebSocketStream} from 'ws';
import {error} from '../runtime/common.mjs';

const assets=fileURLToPath(new URL('../../node_modules/@novnc/novnc/',import.meta.url));
export function viewerAsset(url){
  if(!/^\/novnc\/(?:core|vendor)\/[a-zA-Z0-9_./-]+\.js$/.test(url))throw error('unknown_viewer_asset');
  const name=url.slice('/novnc/'.length),file=path.resolve(assets,name);
  if(name.split('/').some(v=>v==='..'||v==='.')||!file.startsWith(assets)||!fs.existsSync(file)||!fs.statSync(file).isFile())throw error('unknown_viewer_asset');
  return fs.readFileSync(file);
}

// Single-use, identity-bound tickets keep CSRF credentials out of WebSocket
// URLs. Every upgrade still requires the current local cookie or Access JWT.
export function createViewer(server,{access,runtime,verify}){
  const tickets=new Map(),sockets=new Set();
  const wss=new WebSocketServer({noServer:true,maxPayload:1024*1024,perMessageDeflate:false});
  function ticket(workspace,identity){
    for(const [key,value] of tickets)if(value.expires<Date.now())tickets.delete(key);
    if(tickets.size>=128)throw error('viewer_ticket_limit');
    const value=crypto.randomBytes(32).toString('hex');tickets.set(value,{workspace,identity,expires:Date.now()+30000});return {ticket:value};
  }
  server.on('upgrade',async(req,socket,head)=>{
    socket.on('error',()=>socket.destroy());
    try{
      const a=access(),policy=a.policy(req),identity=await a.authenticate(req,policy);
      if(req.headers.origin!==policy.origin)throw error('origin_denied');
      const url=new URL(req.url,'http://control.invalid'),match=/^\/api\/workspaces\/([a-z][a-z0-9-]{0,47})\/viewer$/.exec(url.pathname);
      const key=url.searchParams.get('ticket'),t=tickets.get(key);tickets.delete(key);
      if(!match||!t||t.workspace!==match[1]||t.identity!==identity||t.expires<Date.now())throw error('viewer_ticket_denied');
      verify(t.workspace);
      wss.handleUpgrade(req,socket,head,ws=>{
        sockets.add(ws);const stream=createWebSocketStream(ws);
        try{runtime.attachViewer(t.workspace,stream);}catch{stream.destroy();ws.terminate();}
        const expires=setTimeout(()=>ws.close(1000,'Reconnect to continue'),30*60*1000);
        const check=setInterval(async()=>{try{const current=access(),p=current.policy(req);if(p.origin!==policy.origin||await current.authenticate(req,p)!==identity)throw Error();ws.ping();}catch{ws.terminate();}},30000);
        ws.once('close',()=>{clearTimeout(expires);clearInterval(check);sockets.delete(ws);stream.destroy();});
        ws.on('error',()=>ws.terminate());
      });
    }catch{socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');}
  });
  return {ticket,close(){tickets.clear();for(const ws of sockets)ws.terminate();wss.close();}};
}
