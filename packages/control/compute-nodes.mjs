import crypto from 'node:crypto';
import {error} from '../runtime/common.mjs';

export const nodeId=value=>typeof value==='string'&&/^[a-z][a-z0-9-]{0,47}$/.test(value)&&!['constructor','prototype'].includes(value);
export function controlNodes(config){
  if(config.compute&&config.computeNodes)throw error('choose_compute_or_compute_nodes');
  if(config.workerComputeFile&&!config.compute)throw error('legacy_worker_requires_compute');
  const legacy=!!config.compute;
  const nodes=legacy?[{...config.compute,id:'primary',name:'主服务器',...(config.workerComputeFile?{workerComputeFile:config.workerComputeFile}:{})}]:(config.computeNodes||[]);
  if(!Array.isArray(nodes)||nodes.length>32||new Set(nodes.map(n=>n?.id)).size!==nodes.length)throw error('invalid_compute_nodes');
  for(const n of nodes){
    if(!n||!nodeId(n.id)||n.name!==undefined&&(typeof n.name!=='string'||!n.name.trim()||n.name.length>64||/[\x00-\x1f]/.test(n.name)))throw error('invalid_compute_node');
    if(n.url&&n.ssh||!n.url&&!n.ssh)throw error('choose_one_compute_transport');
  }
  const defaultNode=config.defaultComputeNode??(nodes.length===1?nodes[0].id:null);
  if(defaultNode!==null&&!nodes.some(n=>n.id===defaultNode))throw error('invalid_default_compute_node');
  return {nodes,defaultNode,legacy};
}
export function connectionBinding(connection){
  return crypto.createHash('sha256').update(JSON.stringify(connection)).digest('hex');
}
