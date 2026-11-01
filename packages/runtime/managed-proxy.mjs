import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import dgram from 'node:dgram';
import { spawn } from 'node:child_process';
import { privateDir,writePrivate,executable,cleanEnv,error,sleep } from './common.mjs';

const FIELDS=new Set(['type','server','port','cipher','password','uuid','alterId','tls','servername','sni','alpn','client-fingerprint','network','flow','reality-opts','ws-opts','grpc-opts','plugin','plugin-opts']);
export function publicIPv4(ip){
  if(net.isIP(ip)!==4)return false;const [a,b]=ip.split('.').map(Number);
  return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&b===168||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
}
export async function proxyConfiguration(candidates,port,{lookup=dns.resolve4}={}) {
  if(!Array.isArray(candidates)||!candidates.length||candidates.length>8)throw error('proxy_nodes_required');
  const proxies=[];
  for(const {node,hosts={}} of candidates){
    if(!node||!['ss','vmess','vless','trojan'].includes(node.type)||node['skip-cert-verify']||!Number.isInteger(node.port)||node.port<1||node.port>65535)throw error('invalid_proxy_node');
    if(node.plugin&&!['obfs','v2ray-plugin'].includes(node.plugin))throw error('proxy_plugin_not_supported');
    let target=node.server;const seen=new Set();
    for(let i=0;Object.hasOwn(hosts,target);i++){if(i>=8||seen.has(target))throw error('proxy_alias_cycle');seen.add(target);target=hosts[target];}
    if(typeof target!=='string'||!/^[-a-zA-Z0-9.]+$/.test(target))throw error('invalid_proxy_endpoint');
    const ips=net.isIP(target)?[target]:await lookup(target);
    if(!ips.length||!ips.every(publicIPv4))throw error('proxy_endpoint_not_public_ipv4');
    proxies.push({...Object.fromEntries(Object.entries(node).filter(([k])=>FIELDS.has(k))),name:'exit-'+proxies.length,server:ips[0],udp:false});
  }
  return {'mixed-port':port,'allow-lan':false,'bind-address':'127.0.0.1',mode:'rule','log-level':'error',ipv6:false,
    proxies,'proxy-groups':[{name:'EGRESS',type:'fallback',proxies:proxies.map(n=>n.name),url:'https://www.gstatic.com/generate_204',interval:30,lazy:true}],
    dns:{enable:true,ipv6:false,'respect-rules':true,nameserver:['https://1.1.1.1/dns-query#EGRESS'],'proxy-server-nameserver':['https://1.1.1.1/dns-query#EGRESS']},
    rules:['DOMAIN,localhost,REJECT','DOMAIN-SUFFIX,local,REJECT',...['0.0.0.0/8','10.0.0.0/8','127.0.0.0/8','169.254.0.0/16','172.16.0.0/12','192.168.0.0/16','100.64.0.0/10','198.18.0.0/15','224.0.0.0/4'].map(c=>`IP-CIDR,${c},REJECT`),'IP-CIDR6,::/0,REJECT','MATCH,EGRESS']};
}
export async function availableProxyPort(){
  // Mihomo's mixed listener binds TCP and UDP. Windows can reserve a UDP
  // range even when TCP accepts the same port, so check both protocols.
  for(let attempt=0;attempt<32;attempt++){
    const tcp=net.createServer(),udp=dgram.createSocket('udp4');let bound=false;
    try{
      await new Promise((resolve,reject)=>{tcp.once('error',reject);tcp.listen(0,'127.0.0.1',resolve);});
      const port=tcp.address().port;
      bound=await new Promise(resolve=>{udp.once('error',()=>resolve(false));udp.bind(port,'127.0.0.1',()=>resolve(true));});
      if(bound)return port;
    }finally{
      await new Promise(resolve=>{try{udp.close(resolve);}catch{resolve();}});
      if(tcp.listening)await new Promise(resolve=>tcp.close(resolve));
    }
  }
  throw error('mixed_proxy_port_unavailable');
}
export async function managedProxy(state,candidates,{binary,onExit}={}) {
  binary=binary||executable('mihomo')||executable('verge-mihomo');if(!binary)throw error('mihomo_binary_required');
  const port=await availableProxyPort();
  const config=await proxyConfiguration(candidates,port),dir=privateDir(path.join(state,'egress-private'));
  const file=path.join(dir,'mihomo.json');writePrivate(file,config);
  const log=fs.openSync(path.join(dir,'proxy.log'),'a',0o600);
  const child=spawn(binary,['-d',dir,'-f',file],{shell:false,windowsHide:true,env:cleanEnv(),stdio:['ignore',log,log]});fs.closeSync(log);
  let failed=false;child.on('error',()=>{failed=true;onExit?.();});child.on('exit',()=>onExit?.());
  for(let i=0;i<50;i++){
    if(failed||child.exitCode!==null)throw error('managed_proxy_start_failed');
    const connected=await new Promise(resolve=>{const s=net.connect(port,'127.0.0.1');s.once('connect',()=>{s.destroy();resolve(true);});s.once('error',()=>resolve(false));});
    if(connected)return {upstream:{kind:'http',url:`http://127.0.0.1:${port}`},close:()=>child.kill()};await sleep(100);
  }
  child.kill();throw error('managed_proxy_start_timeout');
}
