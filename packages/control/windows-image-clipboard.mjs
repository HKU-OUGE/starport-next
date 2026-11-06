import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {cleanEnv} from '../runtime/common.mjs';

export const MAX_IMAGE_BYTES=16*1024*1024;
export function imageDimensions(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length<33||bytes.length>MAX_IMAGE_BYTES||!bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))||bytes.readUInt32BE(8)!==13||bytes.toString('ascii',12,16)!=='IHDR')throw Error('invalid_clipboard_image');
  const width=bytes.readUInt32BE(16),height=bytes.readUInt32BE(20);
  if(!width||!height||width*height>32000000)throw Error('clipboard_image_limit');
  return {width,height};
}
// Binary image bodies never become console output or unbounded JSON lines.
export function clipboardDecoder(onFrame){
  let pending=Buffer.alloc(0),header=null;
  return block=>{
    pending=Buffer.concat([pending,block]);
    if(pending.length>MAX_IMAGE_BYTES+65536)throw Error('clipboard_frame_limit');
    while(pending.length){
      if(!header){const at=pending.indexOf(10);if(at<0){if(pending.length>512)throw Error('clipboard_header_limit');return;}
        if(at>512)throw Error('clipboard_header_limit');header=JSON.parse(pending.subarray(0,at));pending=pending.subarray(at+1);
        if(header.kind!=='image'){if(!['ready','clear','unavailable'].includes(header.kind))throw Error('invalid_clipboard_frame');onFrame(header);header=null;continue;}
        if(!Number.isInteger(header.bytes)||header.bytes<33||header.bytes>MAX_IMAGE_BYTES)throw Error('clipboard_image_limit');
      }
      if(pending.length<header.bytes)return;
      const png=Buffer.from(pending.subarray(0,header.bytes));pending=pending.subarray(header.bytes);imageDimensions(png);onFrame({...header,png});header=null;
    }
  };
}

export function windowsImageClipboard(runtime,{launch=spawn}={}){
  let child=null,closed=false,revision=0,latest=null,busy=false,retryAt=0,sessionKey='';
  let state={phase:'stopped',delivered:0,error:null};
  const workspaces=()=>runtime.status().native.filter(n=>n.display==='wslg'&&n.phase==='running').map(n=>n.workspace);
  async function flush(){
    if(busy)return;busy=true;
    try{while(latest&&!closed){const frame=latest;latest=null;const current=revision;
      for(const workspace of workspaces()){
        if(current!==revision)break;
        try{await runtime.nativeImage(workspace,frame.png,()=>current===revision&&!closed);if(current===revision)state={phase:'ready',delivered:state.delivered+1,error:null};}
        catch{if(current===revision&&!closed)state={...state,error:'clipboard_delivery_failed'};}
      }
    }}finally{busy=false;}
  }
  function stop(){revision++;latest=null;if(child){const old=child;child=null;old.stdin.end();old.kill();}state={...state,phase:'stopped'};}
  function tick(){
    if(closed)return;
    const selected=workspaces();
    const key=runtime.status().active?.filter(a=>a.operation==='native'&&selected.includes(a.workspace)).map(a=>a.workspace+':'+a.startedAt).sort().join('|')||selected.join('|');
    if(key!==sessionKey){sessionKey=key;stop();retryAt=0;}
    if(!selected.length){if(child)stop();return;}
    if(child||Date.now()<retryAt)return;
    state={...state,phase:'starting',error:null};
    const powershell=path.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
    const next=launch(powershell,['-NoProfile','-NonInteractive','-STA','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('./windows-image-clipboard.ps1',import.meta.url))],{windowsHide:true,env:cleanEnv(),stdio:['pipe','pipe','pipe']});child=next;
    const fail=()=>{if(child!==next)return;stop();retryAt=Date.now()+15000;state={...state,phase:'unavailable',error:'clipboard_listener_unavailable'};};
    const decode=clipboardDecoder(frame=>{if(child!==next)return;if(frame.kind==='ready'){state={...state,phase:'ready'};return;}revision++;latest=null;if(frame.kind==='image'){latest=frame;void flush();}else if(frame.kind==='unavailable')state={...state,error:'clipboard_image_unavailable'};});
    next.stdout.on('data',block=>{try{decode(block);}catch{fail();}});next.stderr.resume();next.on('error',fail);next.on('close',fail);next.stdin.on('error',fail);
  }
  const timer=setInterval(tick,400);timer.unref();
  return {status:()=>({...state}),close(){closed=true;clearInterval(timer);stop();}};
}
