import fs from 'node:fs';
import path from 'node:path';
import { readJson } from '../config/store.mjs';
import { relative } from '../config/model.mjs';
import { error } from '../runtime/common.mjs';

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
  if(c.wslg!==undefined&&typeof c.wslg!=='boolean')throw error('invalid_wslg_configuration');
  o.wslg=c.wslg===true;
  if(!Number.isInteger(o.port)||o.port<1024||o.port>65535)throw error('invalid_control_port');
  if(c.nodesFile){const s=readJson(resolve(c.nodesFile));o.proxyCandidates=s.nodes.slice(0,8).map(node=>({node,hosts:s.hosts||{}}));}
  if(c.proxyBinary)o.proxyBinary=resolve(c.proxyBinary);
  if(c.apiKeyFile)o.apiKey=secret(c.apiKeyFile);
  if(c.model)o.model=c.model;
  if(c.hosts)o.hosts=c.hosts;
  if(c.compute){
    o.compute={url:c.compute.url,token:secret(c.compute.tokenFile)};
    if(c.compute.ssh)o.compute.ssh={...c.compute.ssh,identityFile:resolve(c.compute.ssh.identityFile),knownHostsFile:resolve(c.compute.ssh.knownHostsFile)};
    if(c.compute.url&&c.compute.ssh)throw error('choose_one_compute_transport');
  }
  if(c.access)o.access=c.access;
  if(c.tunnel)o.tunnel={tokenFile:resolve(c.tunnel.tokenFile),binary:c.tunnel.binary?resolve(c.tunnel.binary):undefined};
  return o;
}
