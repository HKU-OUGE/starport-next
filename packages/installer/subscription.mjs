import {parseDocument} from 'yaml';
import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';
import {publicIPv4,proxyConfiguration} from '../runtime/managed-proxy.mjs';
import {error} from '../runtime/common.mjs';
export function parseSubscription(text){
  if(typeof text!=='string'||Buffer.byteLength(text)>2*1024*1024)throw error('subscription_too_large');
  let data;try{const doc=parseDocument(text);if(doc.errors.length||doc.warnings.length)throw error('invalid_subscription_format');data=doc.toJS({maxAliasCount:50});}catch{throw error('invalid_subscription_format');}
  const raw=Array.isArray(data)?data:data?.proxies||data?.nodes;
  if(!Array.isArray(raw)||!raw.length||raw.length>2000)throw error('clash_subscription_required');
  const nodes=raw.filter(n=>n&&['ss','vmess','vless','trojan'].includes(n.type)&&!n['skip-cert-verify']);
  if(!nodes.length)throw error('supported_proxy_node_required');
  return {nodes,hosts:data?.hosts&&typeof data.hosts==='object'?data.hosts:{}};
}
export async function fetchSubscription(address,{lookup=dns.resolve4,redirects=3}={}){
  let url;try{url=new URL(address);}catch{throw error('invalid_subscription_url');}
  if(url.protocol!=='https:'||url.username||url.password||url.port&&url.port!=='443'||url.href.length>8192)throw error('https_subscription_required');
  const ips=net.isIP(url.hostname)?[url.hostname]:await lookup(url.hostname);
  if(!ips.length||!ips.every(publicIPv4))throw error('public_subscription_endpoint_required');
  const result=await new Promise((resolve,reject)=>{
    const req=https.get(url,{lookup:(_host,options,cb)=>options.all?cb(null,[{address:ips[0],family:4}]):cb(null,ips[0],4),headers:{'user-agent':'Starport-Next-Installer','accept':'application/yaml, text/yaml, text/plain, application/json'},timeout:30000},res=>{
      if([301,302,303,307,308].includes(res.statusCode)){res.resume();resolve({redirect:res.headers.location});return;}
      if(res.statusCode!==200){res.resume();reject(error('subscription_http_'+res.statusCode));return;}
      const parts=[];let count=0;res.on('data',b=>{count+=b.length;if(count>2*1024*1024){res.destroy();reject(error('subscription_too_large'));}else parts.push(b);});res.on('end',()=>resolve({text:Buffer.concat(parts).toString('utf8')}));res.on('error',()=>reject(error('subscription_download_failed')));
    });req.on('timeout',()=>req.destroy());req.on('error',()=>reject(error('subscription_download_failed')));
  });
  if(result.redirect){if(!redirects)throw error('subscription_redirect_limit');return fetchSubscription(new URL(result.redirect,url).href,{lookup,redirects:redirects-1});}
  return parseSubscription(result.text);
}
export async function selectNodes(subscription,indexes){
  if(!subscription||!indexes.length)throw error('choose_proxy_node');
  const nodes=indexes.map(i=>{const node=subscription.nodes[i];if(!node)throw error('invalid_node_selection');return node;});
  // Validate the exact endpoint chain; runtime performs a fresh check too.
  await proxyConfiguration(nodes.map(node=>({node,hosts:subscription.hosts})),12345);
  return {nodes,hosts:subscription.hosts};
}
