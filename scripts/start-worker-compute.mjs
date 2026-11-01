import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {parseArgs} from 'node:util';
import {privateDir,read,writePrivate,error} from '../packages/runtime/common.mjs';
import {createWorkerComputeBridge} from '../packages/control/worker-compute.mjs';
import {WorkerRemote,loadWorkerConnection} from '../packages/control/worker-transport.mjs';
import {managedProxy} from '../packages/runtime/managed-proxy.mjs';
import {createEgress,DEFAULT_HOSTS} from '../packages/runtime/egress.mjs';

const {values}=parseArgs({options:{config:{type:'string'}}});
if(!values.config)throw error('worker_bridge_config_required');
const file=path.resolve(values.config),c=read(file),base=path.dirname(file),resolve=p=>path.resolve(base,p);
if(c.format!=='starport-worker-compute'||c.version!==1||!Number.isInteger(c.port)||c.port<1024||c.port>65535)throw error('invalid_worker_bridge_configuration');
const state=privateDir(resolve(c.state)),connectionFile=resolve(c.connectionFile),connection=loadWorkerConnection(connectionFile);
const hash=crypto.createHash('sha256').update(fs.readFileSync(connectionFile));
for(const key of ['identityFile','knownHostsFile',...(connection.mode==='dsw'?['credentialsFile','proxyClient']:[])])hash.update(fs.readFileSync(connection[key]));
const binding=hash.digest('hex');
if(fs.existsSync(path.join(state,'jobs.json'))&&read(path.join(state,'jobs.json')).binding!==binding)throw error('worker_connection_changed_reconcile_first');
const record=path.join(state,'service.json'),remoteFactory=w=>new WorkerRemote(connection,connectionFile,w);
const nodes=read(resolve(c.nodesFile)),token=fs.readFileSync(resolve(c.tokenFile),'utf8').trim();
let proxy,egress,tunnel,bridge,closed=false;
function close(){if(closed)return;closed=true;bridge?.close();tunnel?.close();egress?.close();proxy?.close();writePrivate(record,{phase:'stopped',pid:process.pid,binding});}
try{
  proxy=await managedProxy(state,nodes.nodes.slice(0,8).map(node=>({node,hosts:nodes.hosts||{}})),{binary:resolve(c.proxyBinary),onExit:()=>egress?.pause()});
  egress=await createEgress({upstream:proxy.upstream,hosts:[...new Set([...DEFAULT_HOSTS,...(c.hosts||[])])]});
  tunnel=await remoteFactory().tunnel(egress.proxyPort);
  bridge=await createWorkerComputeBridge({state,token,binding,remoteFactory,limits:c.limits,port:c.port});
  writePrivate(record,{phase:'running',pid:process.pid,port:bridge.port,binding,startedAt:new Date().toISOString()});
  console.log(JSON.stringify({phase:'running',port:bridge.port}));
}catch(e){close();console.error(e.code||'worker_bridge_failed');process.exitCode=1;}
process.on('SIGTERM',()=>{close();process.exit();});process.on('SIGINT',()=>{close();process.exit();});
