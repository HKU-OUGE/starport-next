import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../config/store.mjs';
import { relative } from '../config/model.mjs';
import { error } from '../runtime/common.mjs';
import { controlNodes,connectionBinding } from './compute-nodes.mjs';

export function loadControlOptions(file){
  const c=readJson(file),base=path.dirname(path.resolve(file));
  const resolve=value=>{if(!relative(value))throw error('relative_control_path_required');return path.resolve(base,value);};
  const secret=value=>{
    const p=resolve(value),st=fs.lstatSync(p);if(st.isSymbolicLink()||!st.isFile()||st.size>65536)throw error('invalid_secret_file');
    if(process.platform!=='win32'&&(st.mode&0o077))throw error('secret_file_must_be_private');
    return fs.readFileSync(p,'utf8').trim();
  };
  if(!c||c.format!=='starport-host-control'||c.version!==1)throw error('invalid_control_configuration');
  const o={port:c.port??18884,wslState:resolve(c.wslState||'wsl'),configurationFile:path.resolve(file)};
  if(c.runtime!==undefined&&(!c.runtime||typeof c.runtime!=='object'||!['qemu','wsl2'].includes(c.runtime.kind)))throw error('invalid_workspace_runtime');
  o.runtimeKind=c.runtime?.kind||(process.platform==='win32'?'wsl2':'qemu');
  o.qemuState=resolve(c.runtime?.kind==='qemu'?(c.runtime.state||'qemu'):'qemu');
  if(c.runtime?.kind==='wsl2')o.wslState=resolve(c.runtime.state||c.wslState||'wsl');
  if(c.seamless!==undefined&&typeof c.seamless!=='boolean')throw error('invalid_seamless_configuration');
  o.seamless=c.seamless===true;
  if(c.seamlessClipboard!==undefined&&!['disabled','text'].includes(c.seamlessClipboard))throw error('invalid_clipboard_mode');
  o.seamlessClipboard=c.seamlessClipboard||'disabled';
  if(c.wslg!==undefined&&typeof c.wslg!=='boolean')throw error('invalid_wslg_configuration');
  o.wslg=c.wslg===true;
  if(!Number.isInteger(o.port)||o.port<1024||o.port>65535)throw error('invalid_control_port');
  if(c.nodesFile){const s=readJson(resolve(c.nodesFile));o.proxyCandidates=s.nodes.slice(0,8).map(node=>({node,hosts:s.hosts||{}}));}
  if(c.proxyBinary)o.proxyBinary=resolve(c.proxyBinary);
  if(c.apiKeyFile)o.apiKey=secret(c.apiKeyFile);
  if(c.model)o.model=c.model;
  if(c.hosts)o.hosts=c.hosts;
  const compute=controlNodes(c);o.defaultComputeNode=compute.defaultNode;
  o.computeNodes=compute.nodes.map(n=>{
    const result={id:n.id,name:n.name||n.id,url:n.url,token:secret(n.tokenFile)};
    if(n.ssh)result.ssh={...n.ssh,identityFile:resolve(n.ssh.identityFile),knownHostsFile:resolve(n.ssh.knownHostsFile)};
    result.binding=connectionBinding({url:n.url,ssh:n.ssh,token:result.token});
    return result;
  });
  if(c.access)o.access=c.access;
  if(c.tunnel)o.tunnel={tokenFile:resolve(c.tunnel.tokenFile),binary:c.tunnel.binary?resolve(c.tunnel.binary):undefined};
  return o;
}
