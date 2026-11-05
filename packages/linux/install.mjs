import path from 'node:path';
import {privateDir} from '../runtime/common.mjs';
import {managedProxy} from '../runtime/managed-proxy.mjs';
import {createEgress,DEFAULT_HOSTS} from '../runtime/egress.mjs';
import {NATIVE_HOSTS} from '../runtime/native.mjs';
import {installProjectVm} from '../runtime/qemu-project.mjs';
export async function installLinuxProject(options,{update=false,onProgress=()=>{},...resources}={}){
  const state=options.qemuState,dir=privateDir(path.join(state,'installer'));let proxy,egress;
  try{
    proxy=await managedProxy(dir,options.proxyCandidates,{binary:options.proxyBinary,onExit:()=>egress?.pause()});
    egress=await createEgress({upstream:proxy.upstream,hosts:[...new Set([...DEFAULT_HOSTS,...NATIVE_HOSTS,'cloud-images.ubuntu.com'])]});
    return await installProjectVm(state,{...resources,proxyPort:egress.proxyPort,installerProxy:proxy.upstream,
      seamless:options.seamless,clients:true,update,onProgress});
  }finally{egress?.close();proxy?.close();}
}
