import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';
import {installation} from './owned-files.mjs';import {desktopArgument} from '../linux/shortcuts.mjs';import {writePrivate,error} from '../runtime/common.mjs';
const [root,action]=process.argv.slice(2),r=installation(root);if(!r||!['register','remove'].includes(action))throw error('invalid_integration_action');
const dir=path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local/share'),'applications'),file=path.join(dir,'starport-next-'+r.id+'.desktop'),receipt=path.join(root,'private/setup/menu.json');
if(fs.existsSync(file)){if(!fs.existsSync(receipt)||crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')!==JSON.parse(fs.readFileSync(receipt)).sha256)throw error('shortcut_ownership_mismatch');}
if(action==='remove'){fs.rmSync(file,{force:true});fs.rmSync(receipt,{force:true});}
else{
 const args=[path.join(root,'runtime/bin/node'),path.join(root,'app/packages/installer/cli.mjs'),'--source',root,'--target',root];
 const content=['[Desktop Entry]','Type=Application','Name=Starport Next','Comment=工作区与安装管理','Exec='+[...args,'--start'].map(desktopArgument).join(' '),'Icon=utilities-terminal','Terminal=false','Categories=Development;','Actions=Manage;','','[Desktop Action Manage]','Name=安装与卸载','Exec='+args.map(desktopArgument).join(' '),''].join('\n');
 fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,content,{mode:0o644});writePrivate(receipt,{file,sha256:crypto.createHash('sha256').update(content).digest('hex')});
}
