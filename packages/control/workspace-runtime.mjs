import path from 'node:path';
import {createWslRuntime} from '../wsl/runtime.mjs';
import {createQemuRuntime} from '../runtime/qemu-project.mjs';
import {createProjectRuntime} from '../runtime/project.mjs';
import {error} from '../runtime/common.mjs';

export function runtimeChoice(options={},platform=process.platform){
  const kind=options.runtimeKind||(platform==='win32'?'wsl2':'qemu');
  if(!['wsl2','qemu'].includes(kind))throw error('unsupported_workspace_runtime');
  if(kind==='wsl2'&&platform!=='win32'&&!options.testLaunch)throw error('wsl_runtime_requires_windows');
  return kind;
}
export async function createWorkspaceRuntime(state,options,shared){
  const kind=runtimeChoice(options);
  if(options.testLaunch)return createProjectRuntime(state,{...shared,launch:options.testLaunch,kind,
    installed:()=>true,wslg:options.wslg===true,seamless:options.seamless===true});
  if(kind==='wsl2')return createWslRuntime(options.wslState||path.join(state,'wsl'),{...shared,wslg:options.wslg===true});
  return createQemuRuntime(options.qemuState||path.join(state,'qemu'),{...shared,seamless:options.seamless===true});
}
