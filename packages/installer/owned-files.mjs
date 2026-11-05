import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {error,hash,read,privateDir,writePrivate} from '../runtime/common.mjs';
export function targetPath(value){
  const root=path.resolve(value);if(root===path.parse(root).root||root===os.homedir()||root.length<8||/[\x00-\x1f"<>|]/.test(root))throw error('invalid_install_directory');
  for(let p=root;;p=path.dirname(p)){if(fs.existsSync(p)&&fs.lstatSync(p).isSymbolicLink())throw error('install_directory_symlink');if(path.dirname(p)===p)break;}
  return root;
}
export function installation(root){
  root=targetPath(root);const file=path.join(root,'installation.json');if(!fs.existsSync(file))return null;
  if(fs.lstatSync(file).isSymbolicLink())throw error('install_receipt_symlink');const r=read(file);
  if(r.format!=='starport-installation'||r.schema!==1||!/^[a-f0-9]{32}$/.test(r.id)||r.root!==root)throw error('installation_ownership_mismatch');return r;
}
export function claim(root){
  root=targetPath(root);const prior=installation(root);if(prior)return prior;
  if(fs.existsSync(root)&&fs.readdirSync(root).length)throw error('unmanaged_install_directory_choose_empty');
  privateDir(root);const receipt={format:'starport-installation',schema:1,id:crypto.randomBytes(16).toString('hex'),root,phase:'prepared',version:null};writePrivate(path.join(root,'installation.json'),receipt);return receipt;
}
export function assertLayout(root){
  for(const name of ['app','runtime','private','backups']){
    const file=path.join(root,name);
    if(fs.existsSync(file)&&fs.lstatSync(file).isSymbolicLink())throw error('installation_layout_symlink');
  }
}
export function acquireLock(root,id){
  const file=path.join(root,'installer.lock');
  if(fs.existsSync(file)){
    if(fs.lstatSync(file).isSymbolicLink())throw error('installation_lock_symlink');
    const old=read(file);let alive=false;
    if(!Number.isInteger(old.pid)||old.pid<1||old.id!==id)throw error('installation_lock_requires_reconciliation');
    try{process.kill(old.pid,0);alive=true;}catch{}
    if(alive)throw error('installation_busy');fs.rmSync(file);
  }
  fs.writeFileSync(file,JSON.stringify({pid:process.pid,id}),{flag:'wx',mode:0o600});
  return ()=>fs.rmSync(file,{force:true});
}
export async function payload(source,platform=process.platform){
  source=path.resolve(source);
  const m=read(path.join(source,'payload-manifest.json'));
  if(m.format!=='starport-release'||m.platform!==platform||m.arch!=='x64'||!Array.isArray(m.files)||m.files.length>20000)throw error('release_platform_mismatch');
  const seen=new Set();for(const f of m.files){
    if(typeof f.path!=='string'||! /^(app|runtime)\//.test(f.path)||f.path.split('/').some(p=>!p||['.','..'].includes(p))||f.path.includes('\\')||!/^[a-f0-9]{64}$/.test(f.sha256)||seen.has(f.path))throw error('invalid_release_manifest');seen.add(f.path);
    const p=path.join(source,...f.path.split('/'));for(let q=p;q!==path.resolve(source);q=path.dirname(q)){if(fs.lstatSync(q).isSymbolicLink())throw error('release_symlink_rejected');}
    if(!fs.statSync(p).isFile()||await hash(p)!==f.sha256)throw error('release_integrity_failed');
  }
  if(!seen.has('app/packages/installer/cli.mjs')||!seen.has(platform==='win32'?'runtime/node.exe':'runtime/bin/node'))throw error('release_entrypoint_missing');return m;
}
export async function copyPayload(source,root,m){
  if(path.resolve(source)===root)return;
  const stage=path.join(root,'.stage-'+crypto.randomBytes(8).toString('hex'));privateDir(stage);
  try{
    for(const f of m.files){const dest=path.join(stage,...f.path.split('/'));fs.mkdirSync(path.dirname(dest),{recursive:true,mode:0o700});fs.copyFileSync(path.join(source,...f.path.split('/')),dest);fs.chmodSync(dest,f.executable?0o700:0o600);if(await hash(dest)!==f.sha256)throw error('installed_file_integrity_failed');}
    for(const name of ['app','runtime']){
      const old=path.join(root,name);if(fs.existsSync(old)){const backup=privateDir(path.join(root,'backups'));fs.renameSync(old,path.join(backup,name+'-'+Date.now()+'-'+crypto.randomBytes(4).toString('hex')));}
      fs.renameSync(path.join(stage,name),old);
    }
    writePrivate(path.join(root,'payload-manifest.json'),m);
  }finally{fs.rmSync(stage,{recursive:true,force:true});}
}
export function assertNoMounts(root){
  if(process.platform!=='linux')return;
  const mounts=fs.readFileSync('/proc/self/mountinfo','utf8').split('\n').filter(Boolean).map(l=>l.split(' ')[4].replace(/\\([0-7]{3})/g,(_,v)=>String.fromCharCode(parseInt(v,8))));
  if(mounts.some(p=>p===root||p.startsWith(root+'/')))throw error('unmount_project_folders_before_uninstall');
}
