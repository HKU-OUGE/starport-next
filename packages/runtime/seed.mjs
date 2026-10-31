import fs from 'node:fs';

// Minimal ISO9660 seed, so Windows setup needs no Unix ISO creation program.
const BLOCK = 2048;
function both16(b, at, n) { b.writeUInt16LE(n, at); b.writeUInt16BE(n, at + 2); }
function both32(b, at, n) { b.writeUInt32LE(n, at); b.writeUInt32BE(n, at + 4); }
function record(sector, size, name, directory = false) {
  const id = Buffer.isBuffer(name) ? name : Buffer.from(name);
  const b = Buffer.alloc(33 + id.length + (id.length % 2 === 0 ? 1 : 0));
  b[0] = b.length; both32(b, 2, sector); both32(b, 10, size);
  Buffer.from([126,1,1,0,0,0,0]).copy(b,18); b[25] = directory ? 2 : 0;
  both16(b,28,1); b[32] = id.length; id.copy(b,33); return b;
}
export function seedIso(file, files) {
  const entries = Object.entries(files); if (!entries.length || entries.length > 8) throw new Error('invalid_seed');
  let sector = 21;
  const items = entries.map(([name, text]) => {
    if (!/^[a-z-]{1,24}$/.test(name)) throw new Error('invalid_seed_name');
    const data = Buffer.from(text); const entry = { name, data, sector };
    sector += Math.ceil(data.length / BLOCK); return entry;
  });
  const image = Buffer.alloc(sector * BLOCK), pvd = image.subarray(16 * BLOCK,17 * BLOCK);
  pvd[0]=1; pvd.write('CD001',1); pvd[6]=1; pvd.fill(32,8,72);
  pvd.write('STARPORT',8); pvd.write('CIDATA',40); both32(pvd,80,sector); both16(pvd,120,1); both16(pvd,124,1); both16(pvd,128,BLOCK);
  both32(pvd,132,10); pvd.writeUInt32LE(18,140); pvd.writeUInt32BE(19,148);
  record(20,BLOCK,Buffer.from([0]),true).copy(pvd,156);
  pvd.fill(32,190,813); pvd[881]=1;
  for (const at of [813,830,847,864]) { pvd.write('2026010100000000',at); pvd[at+16]=0; }
  const term=image.subarray(17*BLOCK,18*BLOCK); term[0]=255; term.write('CD001',1); term[6]=1;
  for (const [index,big] of [[18,false],[19,true]]) {
    const p=image.subarray(index*BLOCK,(index+1)*BLOCK); p[0]=1;
    if(big){p.writeUInt32BE(20,2);p.writeUInt16BE(1,6);}else{p.writeUInt32LE(20,2);p.writeUInt16LE(1,6);}
  }
  const directory=image.subarray(20*BLOCK,21*BLOCK); let offset=0;
  for(const r of [record(20,BLOCK,Buffer.from([0]),true),record(20,BLOCK,Buffer.from([1]),true),...items.map(x=>record(x.sector,x.data.length,x.name.toUpperCase()+';1'))]) {
    if(offset+r.length>BLOCK)throw new Error('seed_directory_too_large');r.copy(directory,offset);offset+=r.length;
  }
  for(const item of items)item.data.copy(image,item.sector*BLOCK);
  fs.writeFileSync(file,image,{mode:0o600,flag:'wx'});
}
export function cloudConfig({ publicKey, hostPrivate, hostPublic }) {
  const body = {
    hostname:'starship', manage_etc_hosts:true, timezone:'Asia/Taipei', locale:'C.UTF-8',
    users:[
      {name:'control',uid:1000,shell:'/bin/bash',lock_passwd:true,sudo:['ALL=(ALL) NOPASSWD:ALL'],ssh_authorized_keys:[publicKey]},
      {name:'agent',uid:1001,shell:'/bin/bash',lock_passwd:true,sudo:null,ssh_authorized_keys:[publicKey]}
    ],
    disable_root:true, ssh_pwauth:false, ssh_deletekeys:true,
    ssh_keys:{ed25519_private:hostPrivate,ed25519_public:hostPublic},
    package_update:false, package_upgrade:false,
    write_files:[
      {path:'/etc/ssh/sshd_config.d/00-starport.conf',permissions:'0644',content:'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin no\nAllowUsers control agent\nAcceptEnv LANG LC_*\nGatewayPorts no\nMatch User agent\n AllowTcpForwarding no\n AllowAgentForwarding no\n X11Forwarding no\n PermitTunnel no\n'},
      {path:'/etc/environment',permissions:'0644',content:'LANG=C.UTF-8\nTZ=Asia/Taipei\n'},
      {path:'/etc/systemd/system/user-1001.slice.d/network.conf',permissions:'0644',content:'[Slice]\nIPAddressDeny=any\nIPAddressAllow=localhost\n'},
      {path:'/etc/systemd/timesyncd.conf.d/starport.conf',permissions:'0644',content:'[Time]\nNTP=\nFallbackNTP=\n'},
      {path:'/etc/cloud/cloud.cfg.d/99-starport-no-updates.cfg',permissions:'0644',content:'apt:\n  preserve_sources_list: true\npackage_update: false\npackage_upgrade: false\n'}
    ],
    runcmd:[
      ['mkdir','-p','/workspace','/output','/opt/starport'],
      ['chown','agent:agent','/workspace','/output'],
      ['systemctl','disable','--now','apt-daily.timer','apt-daily-upgrade.timer'],
      ['systemctl','daemon-reload'],
      ['systemctl','restart','ssh'],
      ['touch','/opt/starport/boot-ready']
    ]
  };
  return '#cloud-config\n'+JSON.stringify(body,null,2)+'\n';
}
