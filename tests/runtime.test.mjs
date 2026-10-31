import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { architecture,cleanEnv,privateDir,run } from '../packages/runtime/common.mjs';
import { qemuArgs,sshArgs,accelerationProbeArgs } from '../packages/runtime/qemu.mjs';
import { cloudConfig,seedIso } from '../packages/runtime/seed.mjs';
import { authority,validateUpstream,createEgress,throughProxy } from '../packages/runtime/egress.mjs';
import { proxyConfiguration,publicIPv4 } from '../packages/runtime/managed-proxy.mjs';
import { guestFiles,verificationMatches } from '../packages/runtime/agent.mjs';

function temp(t){const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-runtime-'));t.after(()=>fs.rmSync(d,{recursive:true,force:true}));return d;}
test('native host mapping uses hardware acceleration without a TCG fallback',()=>{
  assert.equal(architecture('linux','x64').accelerator,'kvm');
  assert.equal(architecture('darwin','arm64').accelerator,'hvf');
  assert.equal(architecture('win32','x64').accelerator,'whpx');
  assert.throws(()=>architecture('win32','arm64'),/not_validated/);
});
test('QEMU network is restricted and only forwards loopback SSH; no host filesystem sharing',()=>{
  for(const [platform,arch] of [['linux','x64'],['darwin','arm64'],['win32','x64']]){
    const args=qemuArgs({host:architecture(platform,arch),cpus:2,memoryMiB:2048,vmId:'example-vm',firmware:'firmware.fd'},'state',22222);
    const network=args[args.indexOf('-netdev')+1];assert.match(network,/restrict=on/);assert.match(network,/ipv6=off/);
    assert.match(network,/hostfwd=tcp:127.0.0.1:22222-:22/);
    assert.ok(!args.some(x=>/^(?:-virtfs|-fsdev|-vnc|-spice|-usbdevice|-incoming)$/.test(x)));
    assert.ok(!args.includes('tcg'));
    if(arch==='x64')assert.match(args[args.indexOf('-cpu')+1],/sse4\.2/);
  }
});
test('SSH uses a pinned workspace host key and disables inherited configuration and agents',()=>{
  const args=sshArgs('state',22222,'agent');
  assert.ok(args.includes('StrictHostKeyChecking=yes'));assert.ok(args.includes('HostKeyAlias=starship'));
  assert.ok(args.includes('IdentityAgent=none'));assert.ok(args.includes('ForwardAgent=no'));assert.ok(args.includes('SendEnv=-*'));
});
test('management subprocess environment does not forward cloud or model credentials',()=>{
  process.env.STARPORT_TEST_SECRET='not-forwarded';process.env.AWS_ACCESS_KEY_ID='example';
  try{const e=cleanEnv();assert.equal(e.STARPORT_TEST_SECRET,undefined);assert.equal(e.AWS_ACCESS_KEY_ID,undefined);assert.equal(e.HOME,undefined);}
  finally{delete process.env.STARPORT_TEST_SECRET;delete process.env.AWS_ACCESS_KEY_ID;}
});
test('seed isolates the agent user from administrative privileges and non-loopback networking',()=>{
  const c=JSON.parse(cloudConfig({publicKey:'ssh-ed25519 example',hostPrivate:'example',hostPublic:'example'}).split('\n').slice(1).join('\n'));
  const agent=c.users.find(u=>u.name==='agent');assert.equal(agent.uid,1001);assert.equal(agent.sudo,null);
  assert.equal(c.timezone,'Asia/Taipei');assert.equal(c.ssh_pwauth,false);
  assert.ok(c.write_files.some(f=>f.path.includes('user-1001.slice')&&f.content.includes('IPAddressDeny=any')));
  assert.ok(c.write_files.some(f=>f.content.includes('AllowTcpForwarding no')));
});
test('ISO seed provides CIDATA and bounded root directory records',t=>{
  const file=path.join(temp(t),'seed.iso');seedIso(file,{'user-data':'#cloud-config\n{}','meta-data':'{}'});
  const b=fs.readFileSync(file);assert.equal(b.toString('ascii',16*2048+1,16*2048+6),'CD001');
  assert.equal(b.toString('ascii',16*2048+40,16*2048+46),'CIDATA');
  assert.ok(b.includes(Buffer.from('USER-DATA;1')));assert.ok(b.includes(Buffer.from('#cloud-config')));
  assert.throws(()=>seedIso(file,{'../escape':'bad'}),/invalid_seed_name/);
});
test('egress only accepts exact public hostnames on HTTPS port 443',()=>{
  assert.equal(authority('example.com:443',['example.com']),'example.com');
  for(const value of ['127.0.0.1:443','169.254.169.254:443','example.com:80','example.com.evil:443','example.com:443\r\nHost: internal'])
    assert.throws(()=>authority(value,['example.com']),/destination_not_allowed/);
});
test('upstream transport cannot silently become a direct remote connection',()=>{
  assert.equal(validateUpstream({kind:'http',url:'http://127.0.0.1:1234'}).kind,'http');
  for(const url of ['http://192.168.1.1:1234','http://user:pass@127.0.0.1:1234','https://example.com'])
    assert.throws(()=>validateUpstream({kind:'http',url}),/loopback_proxy/);
});
test('proxy-only policy excludes provider route rules and DIRECT fallback',async()=>{
  const config=await proxyConfiguration([{node:{type:'trojan',server:'exit.example.com',port:443,password:'example',udp:true},hosts:{}}],19000,{lookup:async()=>['1.1.1.1']});
  assert.equal(config['allow-lan'],false);assert.equal(config.proxies[0].udp,false);
  assert.equal(config.rules.at(-1),'MATCH,EGRESS');assert.ok(!JSON.stringify(config).includes('DIRECT'));
  assert.deepEqual(config['proxy-groups'][0].proxies,['exit-0']);
});
test('proxy alias cycles and private or fake-IP endpoints are rejected',async()=>{
  const node={type:'ss',server:'one.example.com',port:443,password:'example'};
  await assert.rejects(proxyConfiguration([{node,hosts:{'one.example.com':'two.example.com','two.example.com':'one.example.com'}}],19000),/alias_cycle/);
  await assert.rejects(proxyConfiguration([{node}],19000,{lookup:async()=>['198.18.0.1']}),/not_public/);
  for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','198.18.0.1','::1'])assert.equal(publicIPv4(ip),false);
});
test('CONNECT uses only the configured proxy and handles a rejected tunnel without a fallback',async t=>{
  let requests=0;const upstream=net.createServer(socket=>{socket.once('data',data=>{requests++;assert.match(data.toString(),/^CONNECT example.com:443 /);socket.end('HTTP/1.1 503 Unavailable\r\n\r\n');});});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
  await assert.rejects(throughProxy({kind:'http',url:`http://127.0.0.1:${upstream.address().port}`},'example.com'),/proxy_rejected/);
  assert.equal(requests,1);
});
test('workspace API requires its capability and does not expose upstream credentials',async t=>{
  const gateway=await createEgress({upstream:{kind:'http',url:'http://127.0.0.1:9'},apiKey:'example-real-key',model:'example-model'});t.after(()=>gateway.close());
  const r=await fetch(`http://127.0.0.1:${gateway.apiPort}/v1/messages`,{method:'POST',body:'{}'});
  assert.equal(r.status,401);assert.ok(!(await r.text()).includes('example-real-key'));
  gateway.pause();const closed=await fetch(`http://127.0.0.1:${gateway.apiPort}/v1/messages`,{method:'POST',headers:{'x-api-key':gateway.capability},body:'{}'});
  assert.equal(closed.status,503);assert.equal(gateway.requests,0);
});
test('native SDK installation includes only the selected Linux glibc binary',()=>{
  for(const arch of ['x64','arm64']){
    const files=guestFiles(arch),pkg=JSON.parse(files['package.json']),lock=JSON.parse(files['package-lock.json']);
    const native='@anthropic-ai/claude-agent-sdk-linux-'+arch;
    assert.equal(pkg.dependencies[native],pkg.dependencies['@anthropic-ai/claude-agent-sdk']);
    assert.equal(lock.packages['node_modules/'+native].optional,undefined);
    assert.equal(lock.packages['node_modules/'+native+'-musl'].optional,true);
    assert.equal(Object.keys(pkg.dependencies).length,3);
  }
});
test('long output is streamed with bounded recent capture rather than killing the task',async()=>{
  let bytes=0;
  const r=await run(process.execPath,['-e','process.stdout.write("a".repeat(200000))'],{boundedCapture:true,maxBytes:1024,onData:x=>{bytes+=x.length;}});
  assert.equal(r.code,0);assert.equal(bytes,200000);assert.equal(r.stdout.length,1024);
});
test('model admission rejects old VM runs, changed policy and malformed verification dates',()=>{
  const status={vmId:'vm',runId:'run',settingsDigest:'digest'},now=Date.now();
  const v={...status,passed:true,checkedAt:new Date(now-1000).toISOString()};
  assert.equal(verificationMatches(v,status,now),true);
  for(const patch of [{runId:'old'},{settingsDigest:'old'},{checkedAt:'bad'},{checkedAt:new Date(now+60000).toISOString()},{checkedAt:new Date(now-86400001).toISOString()}])
    assert.equal(verificationMatches({...v,...patch},status,now),false);
});

test('hardware acceleration preflight has no disk, network, host share or running guest workload',()=>{
  for(const [platform,arch] of [['linux','x64'],['win32','x64'],['darwin','arm64']]){
    const a=accelerationProbeArgs(architecture(platform,arch));
    assert.ok(a.includes('-S'));assert.ok(a.includes('-nodefaults'));
    assert.equal(a[a.indexOf('-net')+1],'none');
    assert.ok(!a.some(v=>['-drive','-fsdev','-virtfs','-vnc','-spice'].includes(v)));
  }
});
test('confirmed stopped workspace remains queryable after its supervisor HTTP endpoint exits',async t=>{
  const {control}=await import('../packages/runtime/control.mjs');const d=temp(t);
  fs.writeFileSync(path.join(d,'runtime.json'),JSON.stringify({phase:'stopped',ready:false,controlPort:9,token:'example-token',vmId:'vm',runId:'run'}));
  const result=await control(d);assert.equal(result.running,false);assert.equal(result.stopConfirmed,true);assert.equal(result.token,undefined);
  assert.deepEqual(await control(d,'/stop','POST'),{stopping:false,stopped:true});
});
test('unreachable runtime without a confirmed stop is never reported as stopped',async t=>{
  const {control}=await import('../packages/runtime/control.mjs');const d=temp(t);
  fs.writeFileSync(path.join(d,'runtime.json'),JSON.stringify({phase:'ready',ready:true,controlPort:9,token:'example-token'}));
  await assert.rejects(control(d),/runtime_control_unavailable/);
});
