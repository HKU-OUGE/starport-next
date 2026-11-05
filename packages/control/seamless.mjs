import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {privateDir,error,executable} from '../runtime/common.mjs';

const launcher=fileURLToPath(new URL('../linux/seamless-client.py',import.meta.url));
export function createSeamless(state,runtime,{launch=spawn,platform=process.platform,available=executable}={}){
  const sessions=new Map(),pending=new Map(),base=privateDir(path.join(os.tmpdir(),'starport-viewer-'+process.getuid()+'-'+crypto.createHash('sha256').update(path.resolve(state)).digest('hex').slice(0,12)));
  async function disconnect(workspace){
    const entry=sessions.get(workspace);if(!entry)return;
    for(const peer of entry.peers)peer.destroy();
    await new Promise(resolve=>{entry.server.close(()=>resolve());});
    if(entry.child.exitCode===null)await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(error('seamless_stop_requires_reconciliation')),3000);entry.child.once('exit',()=>{clearTimeout(timer);resolve();});entry.child.kill();});
    if(sessions.get(workspace)===entry)sessions.delete(workspace);
  }
  async function connect(workspace){
      if(platform!=='linux'||!runtime.status().seamless)throw error('seamless_authorization_required');
      if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw error('invalid_workspace');
      if(!available('xpra')||!available('bwrap'))throw error('seamless_client_not_installed');
      const clipboard=runtime.status().seamlessClipboard||'disabled';
      if(!['disabled','text'].includes(clipboard))throw error('invalid_clipboard_mode');
      const old=sessions.get(workspace);if(old&&old.child.exitCode===null&&old.peers.size)return {phase:'running',display:'seamless',reused:true,clipboard,fileTransfer:false};
      if(old)await disconnect(workspace);
      const socket=path.join(base,workspace+'.sock');
      if(Buffer.byteLength(socket)>100)throw error('seamless_state_path_too_long');
      // Only reclaim this user's private, refused Unix socket after a crash.
      if(fs.existsSync(socket)){
        const st=fs.lstatSync(socket);if(!st.isSocket()||st.uid!==process.getuid()||st.mode&0o077)throw error('seamless_socket_requires_reconciliation');
        const refused=await new Promise(resolve=>{const p=net.connect(socket);p.once('connect',()=>{p.destroy();resolve(false);});p.once('error',e=>resolve(e.code==='ECONNREFUSED'));p.setTimeout(1000,()=>{p.destroy();resolve(false);});});
        if(!refused)throw error('seamless_socket_requires_reconciliation');fs.unlinkSync(socket);
      }
      const peers=new Set();
      const server=net.createServer(stream=>{
        if(peers.size){stream.destroy();return;}
        peers.add(stream);stream.once('close',()=>peers.delete(stream));
        try{runtime.attachViewer(workspace,stream,{display:'seamless'});}catch{stream.destroy();}
      });
      await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socket,resolve);});fs.chmodSync(socket,0o600);
      const log=fs.openSync(path.join(base,workspace+'.log'),'a',0o600);
      const child=launch('/usr/bin/python3',[launcher,'--clipboard',clipboard,'--socket',socket],{shell:false,stdio:['ignore','pipe',log]});fs.closeSync(log);
      const entry={server,child,peers};sessions.set(workspace,entry);
      const close=()=>{for(const peer of peers)peer.destroy();server.close();if(sessions.get(workspace)===entry)sessions.delete(workspace);};
      child.once('exit',close);child.once('error',close);
      await new Promise((resolve,reject)=>{let pending='';const timer=setTimeout(()=>{child.kill();reject(error('seamless_client_start_failed'));},20000);child.stdout.on('data',b=>{pending=(pending+b).slice(-1024);if(pending.includes('STARPORT_VIEWER_READY')){clearTimeout(timer);resolve();}});child.once('error',()=>{clearTimeout(timer);reject(error('seamless_client_start_failed'));});child.once('exit',()=>{clearTimeout(timer);reject(error('seamless_client_start_failed'));});});
      return {phase:'running',display:'seamless',clipboard,fileTransfer:false};
  }
  return {
    connect(workspace){if(pending.has(workspace))return pending.get(workspace);const task=connect(workspace).finally(()=>pending.delete(workspace));pending.set(workspace,task);return task;},
    disconnect,
    close(){for(const {child,server,peers} of sessions.values()){child.kill();for(const peer of peers)peer.destroy();server.close();}sessions.clear();}
  };
}
