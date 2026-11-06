import os from 'node:os';
import path from 'node:path';
import {error} from '../runtime/common.mjs';
export const VERSION='0.3.0-beta.2';
export function defaultTarget(platform=process.platform){return platform==='win32'?path.join(process.env.LOCALAPPDATA||os.homedir(),'StarportNext'):path.join(process.env.XDG_DATA_HOME||path.join(os.homedir(),'.local/share'),'starport-next');}
export const defaultFeatures={workspace:true,clients:true,inputMethod:true,seamless:false,clipboard:false,startup:false,api:false,compute:false,remote:false};
export function validatePlan(value,platform=process.platform){
  if(!['linux','win32'].includes(platform))throw error('installer_platform_not_supported');
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['features','credentialStorage','basicAcknowledged','port','cpus','memoryMiB','diskGiB','model','apiKey','nodeIndexes','compute','remote'].includes(k)))throw error('invalid_install_plan');
  const f={...defaultFeatures,...value.features};
  if(Object.keys(f).some(k=>!Object.hasOwn(defaultFeatures,k)||typeof f[k]!=='boolean'))throw error('invalid_install_features');
  if(!f.workspace&&(f.clients||f.inputMethod||f.seamless||f.clipboard))throw error('workspace_required_for_clients');
  if(!f.clients&&(f.inputMethod||f.seamless||f.clipboard))throw error('clients_required_for_display');
  if(f.api&&(!f.workspace||!f.clients))throw error('api_requires_workspace_clients');
  if(f.clipboard&&!f.seamless)throw error('seamless_required_for_clipboard');
  const store=value.credentialStorage||'keyring';
  if(!['keyring','basic'].includes(store)||store==='basic'&&value.basicAcknowledged!==true)throw error('basic_storage_requires_explicit_choice');
  const bounded=(v,min,max,code)=>{if(!Number.isInteger(v)||v<min||v>max)throw error(code);return v;};
  const text=(v,max)=>{if(typeof v!=='string'||v.length>max||v.includes('\0'))throw error('invalid_install_text');return v.trim();};
  const model=text(value.model||'claude-sonnet-4-6',160);if(!/^[a-zA-Z0-9_.:-]+$/.test(model))throw error('invalid_model_id');
  const p={features:f,credentialStorage:store,port:bounded(value.port??18884,1024,65535,'invalid_panel_port'),cpus:bounded(value.cpus??2,1,64,'invalid_cpu_budget'),memoryMiB:bounded(value.memoryMiB??4096,2048,65536,'invalid_memory_budget'),diskGiB:bounded(value.diskGiB??24,16,1024,'invalid_disk_budget'),model,apiKey:text(value.apiKey||'',65536),nodeIndexes:value.nodeIndexes||[]};
  if(!Array.isArray(p.nodeIndexes)||p.nodeIndexes.length>8||p.nodeIndexes.some(n=>!Number.isInteger(n)||n<0||n>1999)||new Set(p.nodeIndexes).size!==p.nodeIndexes.length)throw error('invalid_node_selection');
  if(f.compute){const c=value.compute||{};p.compute={host:text(c.host||'',253),user:text(c.user||'',64),sshPort:bounded(c.sshPort??22,1,65535,'invalid_ssh_port'),serverPort:bounded(c.serverPort??19090,1,65535,'invalid_service_port'),privateKey:text(c.privateKey||'',32768),knownHosts:text(c.knownHosts||'',16384),token:text(c.token||'',65536)};if(!/^[a-zA-Z0-9.-]+$/.test(p.compute.host)||p.compute.host.startsWith('-')||!/^[a-zA-Z0-9_-]+$/.test(p.compute.user)||p.compute.user.startsWith('-'))throw error('invalid_compute_connection');}
  if(f.remote){const r=value.remote||{};p.remote={hostname:text(r.hostname||'',253).toLowerCase(),issuer:text(r.issuer||'',512),audience:text(r.audience||'',1024),token:text(r.token||'',65536),emails:Array.isArray(r.emails)?r.emails.map(x=>text(x,254).toLowerCase()):[]};if(!/^([a-z0-9-]+\.)+[a-z]{2,}$/.test(p.remote.hostname)||!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(p.remote.issuer)||!p.remote.audience||!p.remote.emails.length||p.remote.emails.length>64||p.remote.emails.some(e=>!/^\S+@\S+\.\S+$/.test(e)))throw error('invalid_remote_access');}
  return p;
}
export function publicPlan(p){if(!p)return null;return {...p,apiKey:p.apiKey?'saved':'',compute:p.compute?{...p.compute,privateKey:p.compute.privateKey?'saved':'',knownHosts:p.compute.knownHosts?'saved':'',token:p.compute.token?'saved':''}:undefined,remote:p.remote?{...p.remote,token:p.remote.token?'saved':''}:undefined};}
export function stageList(p){return ['files','configuration','prerequisites',...(p.features.workspace?['proxy','workspace',...(p.features.clients?['clients']:[])]:[]),...(p.features.remote?['tunnel']:[]),'shortcuts','control',...(p.features.workspace?['verification']:[]),...(p.features.startup?['startup']:[]),'complete'];}
