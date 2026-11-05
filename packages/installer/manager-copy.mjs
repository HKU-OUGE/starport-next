import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {spawn} from 'node:child_process';
import {payload} from './owned-files.mjs';import {writePrivate} from '../runtime/common.mjs';
export async function copyManager(root){
 const manifest=await payload(root),nonce=crypto.randomBytes(16).toString('hex'),dir=path.join(fs.realpathSync(os.tmpdir()),'starport-manager-'+nonce);fs.mkdirSync(dir,{mode:0o700});
 try{for(const f of manifest.files){const dest=path.join(dir,...f.path.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.copyFileSync(path.join(root,...f.path.split('/')),dest);fs.chmodSync(dest,f.executable?0o700:0o600);}fs.copyFileSync(path.join(root,'payload-manifest.json'),path.join(dir,'payload-manifest.json'));return {dir,nonce};}
 catch(e){fs.rmSync(dir,{recursive:true,force:true});throw e;}
}
export function cleanupManager(dir,nonce){
 if(!/^starport-manager-[a-f0-9]{32}$/.test(path.basename(dir)))throw Error('invalid_manager_directory');
 if(process.platform==='win32'){
  writePrivate(path.join(dir,'manager-owner.json'),{pid:process.pid,nonce});
  const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(dir,'app/packages/installer/cleanup-manager.ps1'),'-Directory',dir,'-OwnerPid',String(process.pid),'-Nonce',nonce],{stdio:'ignore',detached:true,windowsHide:true});child.unref();
 }else fs.rmSync(dir,{recursive:true,force:true});
}
