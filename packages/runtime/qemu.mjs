import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
import { architecture, executable, error, privateDir, writePrivate, read, run, hash, assertSpace, checkMemory, cleanEnv } from './common.mjs';
import { seedIso, cloudConfig } from './seed.mjs';
import { fetchThroughProxy } from './egress.mjs';

export function accelerationProbeArgs(host) {
  return ['-machine',host.arch==='arm64'?'virt':'q35','-accel',host.accelerator,'-cpu',host.arch==='arm64'?'host':'qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt',
    '-m','128','-nodefaults','-net','none','-display','none','-monitor','none','-serial','none','-S','-qmp','stdio'];
}
export function doctor() {
  const host=architecture(); const programs=Object.fromEntries([host.qemu,'qemu-img','ssh','ssh-keygen'].map(n=>[n,executable(n)]));
  let acceleration=false,accelerationReason='qemu_missing';
  if(programs[host.qemu]){
    const probe=spawnSync(programs[host.qemu],accelerationProbeArgs(host),{env:cleanEnv(),input:'{"execute":"qmp_capabilities"}\n{"execute":"quit"}\n',encoding:'utf8',timeout:10000,windowsHide:true,maxBuffer:1024*1024});
    acceleration=probe.status===0&&Boolean(probe.stdout?.includes('QMP'));
    accelerationReason=acceleration?null:'hardware_acceleration_probe_failed';
  }
  const missing=Object.entries(programs).filter(([,p])=>!p).map(([n])=>n);
  let firmware=null;
  if(host.arch==='arm64') {
    for(const p of ['/opt/homebrew/share/qemu/edk2-aarch64-code.fd','/usr/share/qemu/edk2-aarch64-code.fd','/usr/share/AAVMF/AAVMF_CODE.fd'])if(fs.existsSync(p)){firmware=p;break;}
    if(!firmware)missing.push('aarch64-uefi-firmware');
  }
  return {host,programs,firmware,acceleration,accelerationReason,ready:!missing.length&&acceleration,missing,requiresActualBoot:true};
}
export function qemuArgs(config, state, port) {
  const d=config.host, args=['-name','starship','-accel',d.accelerator,'-m',String(config.memoryMiB),'-smp',String(config.cpus),
    '-display','none','-monitor','none','-qmp','stdio','-serial',`file:${path.join(state,'serial.log')}`,
    '-no-reboot','-rtc','base=utc,clock=rt','-uuid',config.vmId,
    '-drive',`file=${path.join(state,'workspace.qcow2')},if=none,id=root,format=qcow2,discard=unmap`,
    '-device','virtio-blk-pci,drive=root','-drive',`file=${path.join(state,'seed.iso')},if=none,id=seed,format=raw,readonly=on`,
    '-device','virtio-blk-pci,drive=seed',
    '-netdev',`user,id=isolated,restrict=on,ipv6=off,hostname=starship,net=10.0.2.0/24,dhcpstart=10.0.2.15,hostfwd=tcp:127.0.0.1:${port}-:22`,
    '-device','virtio-net-pci,netdev=isolated'];
  if(d.arch==='arm64')args.push('-machine','virt,gic-version=3','-cpu','host','-bios',config.firmware);
  // Bun-based Agent SDK requires SSE4.2. Expose a generic CPU with that baseline,
  // rather than passing through the host CPU model or silently falling back.
  else args.push('-machine','q35','-cpu','qemu64,+ssse3,+sse4.1,+sse4.2,+popcnt');
  return args;
}
async function download(url,file,expected,onProgress,installerProxy) {
  if(fs.existsSync(file)&&await hash(file)===expected)return;
  if(fs.existsSync(file))throw error('existing_image_checksum_mismatch');
  const temp=file+'.partial',offset=fs.existsSync(temp)?fs.statSync(temp).size:0;
  const headers=offset?{Range:`bytes=${offset}-`}:{};
  const response=installerProxy?await fetchThroughProxy(url,installerProxy,{headers}):await fetch(url,{redirect:'error',headers,signal:AbortSignal.timeout(900000)});
  const status=response.statusCode||response.status;
  if(status!==(offset?206:200))throw error('image_download_failed');
  const header=name=>response.headers.get?response.headers.get(name):response.headers[name];
  if(offset&&!String(header('content-range')).startsWith(`bytes ${offset}-`))throw error('image_resume_range_mismatch');
  const total=Number(header('content-length'))+offset;
  const fd=fs.openSync(temp,offset?'a':'wx',0o600);let bytes=offset,last=0;
  try{
    for await(const data of response.body||response){
      bytes+=data.length;if(bytes>1024**3)throw error('image_download_too_large');fs.writeSync(fd,data);
      if(Date.now()-last>3000){onProgress?.({stage:'downloading_image',bytes,total});last=Date.now();}
    }
    fs.closeSync(fd);
    if(await hash(temp)!==expected)throw error('image_checksum_mismatch');
    fs.renameSync(temp,file);
  }catch(e){try{fs.closeSync(fd);}catch{}fs.rmSync(temp,{force:true});throw e;}
}
export async function prepare(state,{cpus=2,memoryMiB=2048,diskGiB=8,ephemeral=false,onProgress,installerProxy}={}) {
  const d=doctor();if(!d.ready)throw error('runtime_prerequisites_missing');
  if(!Number.isInteger(cpus)||cpus<1||cpus>32||!Number.isInteger(diskGiB)||diskGiB<4||diskGiB>256)throw error('invalid_resource_budget');
  checkMemory(memoryMiB);state=privateDir(state);
  // Temporary RAM-backed acceptance is explicit; persistent installs reserve disk plus a host margin.
  assertSpace(state,ephemeral?1536*1024**2:(diskGiB+2)*1024**3);
  if(fs.existsSync(path.join(state,'machine.json')))throw error('workspace_already_prepared');
  if(fs.existsSync(path.join(state,'prepare.lock')))throw error('prepare_already_in_progress');
  fs.writeFileSync(path.join(state,'prepare.lock'),String(process.pid),{flag:'wx',mode:0o600});
  try{
    const name=`ubuntu-24.04-minimal-cloudimg-${d.host.guest}.img`;
    const base='https://cloud-images.ubuntu.com/minimal/releases/noble/release/';
    const response=installerProxy?await fetchThroughProxy(base+'SHA256SUMS',installerProxy):await fetch(base+'SHA256SUMS',{redirect:'error',signal:AbortSignal.timeout(30000)});
    if((response.statusCode||response.status)!==200)throw error('image_manifest_failed');
    let sums='';if(response.text)sums=await response.text();else for await(const p of response){sums+=p;if(sums.length>65536)throw error('image_manifest_invalid');}
    const expected=sums.split('\n').find(x=>x.endsWith(' *'+name))?.split(' ')[0];
    if(!/^[a-f0-9]{64}$/.test(expected||''))throw error('image_manifest_invalid');
    await download(base+name,path.join(state,'base.qcow2'),expected,onProgress,installerProxy);
    for(const key of ['identity','host-key']) {
      if(fs.existsSync(path.join(state,key)))throw error('partial_workspace_requires_review');
      const result=await run(d.programs['ssh-keygen'],['-q','-t','ed25519','-N','','-C','starport-workspace','-f',path.join(state,key)]);
      if(result.code!==0)throw error('key_creation_failed');
    }
    const hostPublic=fs.readFileSync(path.join(state,'host-key.pub'),'utf8').trim();
    seedIso(path.join(state,'seed.iso'),{
      'user-data':cloudConfig({publicKey:fs.readFileSync(path.join(state,'identity.pub'),'utf8').trim(),hostPrivate:fs.readFileSync(path.join(state,'host-key'),'utf8'),hostPublic}),
      'meta-data':JSON.stringify({'instance-id':'starship-'+crypto.randomBytes(8).toString('hex'),'local-hostname':'starship'}),
      'network-config':JSON.stringify({version:2,ethernets:{primary:{match:{name:'en*'},dhcp4:true,dhcp6:false,'dhcp4-overrides':{'use-dns':false,'use-domains':false},nameservers:{addresses:['127.0.0.1']}}}})
    });
    const disk=await run(d.programs['qemu-img'],['create','-f','qcow2','-F','qcow2','-b',path.join(state,'base.qcow2'),path.join(state,'workspace.qcow2'),`${diskGiB}G`]);
    if(disk.code!==0)throw error('workspace_disk_creation_failed');
    writePrivate(path.join(state,'known_hosts'),'starship '+hostPublic+'\n');
    fs.rmSync(path.join(state,'host-key')); // Only the guest seed needs its server private key.
    writePrivate(path.join(state,'machine.json'),{format:1,host:d.host,firmware:d.firmware,vmId:crypto.randomUUID(),cpus,memoryMiB,diskGiB,ephemeral,imageSha256:expected,
      imageSource:base+name,createdAt:new Date().toISOString()});
    return {prepared:true,ephemeral,cpus,memoryMiB,diskGiB,imageVerified:true};
  }finally{fs.rmSync(path.join(state,'prepare.lock'),{force:true});}
}
export function sshArgs(state,port,user='control',extra=[]) {
  const hosts=JSON.stringify(path.join(state,'known_hosts').replaceAll('\\','/'));
  return ['-F',process.platform==='win32'?'NUL':'/dev/null','-T','-p',String(port),'-i',path.join(state,'identity'),
    '-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','IdentityAgent=none','-o','StrictHostKeyChecking=yes',
    '-o','HostKeyAlias=starship','-o',`UserKnownHostsFile=${hosts}`,
    '-o','GlobalKnownHostsFile='+ (process.platform==='win32'?'NUL':'/dev/null'),'-o','ConnectTimeout=4','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=3',
    '-o','ForwardAgent=no','-o','SendEnv=-*',...extra,`${user}@127.0.0.1`];
}
export async function guest(state,port,command,{user='agent',input,timeout,onData,maxBytes,boundedCapture}={}) {
  const result=await run(executable('ssh'),[...sshArgs(state,port,user),command],{input,timeout,onData,maxBytes,boundedCapture});
  return result;
}
