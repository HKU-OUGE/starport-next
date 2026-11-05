import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {read,writePrivate,privateDir,error} from '../runtime/common.mjs';
const repo=fileURLToPath(new URL('../../',import.meta.url));
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
export function desktopArgument(value){
  if(typeof value!=='string'||/[\x00-\x1f\x7f]/.test(value))throw error('invalid_shortcut_argument');
  // Desktop Entry escaping, then Exec field escaping. No shell interpreter.
  return '"'+value.replaceAll('\\','\\\\\\\\').replaceAll('"','\\\\"').replaceAll('`','\\\\`').replaceAll('$','\\\\$').replaceAll('%','%%')+'"';
}
export function linuxShortcuts(state,{workspace='main',seamless=false,directory=path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local/share'),'applications'),node=process.execPath,repository=repo,remove=false}={}){
  state=privateDir(state);if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw error('invalid_workspace');
  const id=hash(state+'\0'+workspace).slice(0,16),manifest=path.join(state,'shortcuts-'+workspace+'.json');
  let old;if(fs.existsSync(manifest))old=read(manifest);
  if(old){
    if(old.id!==id||old.directory!==directory||!Array.isArray(old.files))throw error('shortcut_ownership_mismatch');
    for(const f of old.files){if(!new RegExp('^starport-'+id+'-(panel|code|browser|terminal|access)\\.desktop$').test(f.name))throw error('invalid_shortcut_manifest');const p=path.join(directory,f.name),st=fs.lstatSync(p);if(st.isSymbolicLink()||st.uid!==process.getuid()||hash(fs.readFileSync(p))!==f.sha256)throw error('shortcut_changed');}
    if(!remove)return {registered:true,reused:true,count:old.files.length};
    for(const f of old.files)fs.unlinkSync(path.join(directory,f.name));fs.unlinkSync(manifest);return {removed:true};
  }
  if(remove)return {removed:false};
  fs.mkdirSync(directory,{recursive:true});if(fs.lstatSync(directory).isSymbolicLink())throw error('shortcut_directory_symlink');
  const apps=[['panel','Starport Next','panel'],['access','Starport · 访问码','access'],...(seamless?[['code','Starport · Claude Desktop','desktop'],['browser','Starport · 浏览器','browser'],['terminal','Starport · Claude Code','terminal']]:[])];
  const files=[];
  try{
    for(const [name,title,app] of apps){
      const file='starport-'+id+'-'+name+'.desktop';const argv=[node,path.join(repository,'scripts/linux-open.mjs'),'--state',state,'--workspace',workspace,'--app',app];
      const text=['[Desktop Entry]','Type=Application','Version=1.0','Name='+title+' ('+workspace+')','Exec='+argv.map(desktopArgument).join(' '),'Icon=utilities-terminal','Terminal=false','Categories=Development;','StartupNotify=false',''].join('\n');
      fs.writeFileSync(path.join(directory,file),text,{flag:'wx',mode:0o644});files.push({name:file,sha256:hash(text)});
    }
    writePrivate(manifest,{id,directory,files});return {registered:true,count:files.length};
  }catch(e){for(const f of files)fs.unlinkSync(path.join(directory,f.name));throw e;}
}
