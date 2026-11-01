import path from 'node:path';
import {spawn} from 'node:child_process';
import {read,error} from '../runtime/common.mjs';

export function workspaceExplorerPath(receipt,workspace){
  if(receipt?.phase!=='installed'||!/^StarportWork-[a-f0-9]{16}$/.test(receipt.distribution||''))throw error('owned_wsl_installation_required');
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace||''))throw error('invalid_workspace');
  return `\\\\wsl.localhost\\${receipt.distribution}\\var\\lib\\starport-workspaces\\${workspace}\\project`;
}
export async function openWorkspaceFolder(state,workspace,{platform=process.platform,launch=spawn,windowsRoot=process.env.SystemRoot}={}){
  if(platform!=='win32')throw error('local_windows_action_required');
  const folder=workspaceExplorerPath(read(path.join(state,'wsl.json')),workspace);
  const child=launch(path.win32.join(windowsRoot||'C:\\Windows','explorer.exe'),[folder],{shell:false,windowsHide:false,detached:true,stdio:'ignore'});
  await new Promise((resolve,reject)=>{child.once('error',()=>reject(error('explorer_launch_failed')));child.once('spawn',resolve);});
  child.unref();return {opened:true,folder};
}
