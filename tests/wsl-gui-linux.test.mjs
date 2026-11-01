import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {spawnSync} from 'node:child_process';
import {fixture} from './wsl-fixture.mjs';
import {createWslRuntime} from '../packages/wsl/runtime.mjs';
import {createEgress} from '../packages/runtime/egress.mjs';

for(const remote of [false,true]){
const supported=process.platform==='linux'&&(remote||fs.existsSync('/mnt/wslg/runtime-dir/wayland-0')&&fs.existsSync('/tmp/.X11-unix/X0'))&&spawnSync('unshare',['-Urn','true']).status===0;
test(`real ${remote?'remote display':'WSLg'} policy preserves outer network/filesystem isolation and Chromium nested namespaces`,{skip:!supported,timeout:60000},async t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-gui-proof-'));
  const upstream=http.createServer();upstream.on('connect',(_req,s)=>{s.write('HTTP/1.1 200 Connection Established\r\n\r\n');s.on('data',b=>s.write(b));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const e=await createEgress({upstream:{kind:'http',url:`http://127.0.0.1:${upstream.address().port}`},hosts:['example.com']});
  const r=createWslRuntime(dir,{launch:fixture(dir,{gui:true,remote}),destinations:{proxy:e.proxyPort,model:e.apiPort,compute:e.apiPort},capabilities:()=>({})});
  t.after(()=>{r.close();e.close();upstream.closeAllConnections();upstream.close();fs.rmSync(dir,{recursive:true,force:true});});
  const run=script=>r.execute('main',{operation:'exec',argv:['/usr/bin/python3','-I','-c',script]});
  const result=await run(`import json,pathlib,os,socket,subprocess,ctypes,errno
def denied(f):
 try:f();return False
 except OSError:return True
lib=ctypes.CDLL(None,use_errno=True)
mount=lib.mount(b'none',b'/tmp',b'tmpfs',0,None)==-1 and ctypes.get_errno()==errno.EPERM
setns=lib.setns(-1,0)==-1 and ctypes.get_errno()==errno.EPERM
print(json.dumps({
 'displaySocket':${remote?"not pathlib.Path('/run/user/1000/wayland-0').exists() and not pathlib.Path('/tmp/.X11-unix/X0').exists()":"pathlib.Path('/run/user/1000/wayland-0').is_socket()"},
 'windowsAbsent':not pathlib.Path('/mnt/c').exists(),
 'entireWslgAbsent':not pathlib.Path('/mnt/wslg').exists(),
 'hostBusAbsent':not pathlib.Path('/run/dbus/system_bus_socket').exists(),
 'hostHomeAbsent':list(pathlib.Path('/home').iterdir())==[pathlib.Path('/home/agent')],
 'noRoute':len(pathlib.Path('/proc/net/route').read_text().strip().splitlines())==1,
 'tcpDenied':denied(lambda:socket.create_connection(('1.1.1.1',443),timeout=1)),
 'ipv6Denied':denied(lambda:socket.create_connection(('2606:4700:4700::1111',443),timeout=1)),
 'metadataDenied':denied(lambda:socket.create_connection(('169.254.169.254',80),timeout=1)),
 'dnsDenied':denied(lambda:socket.socket(socket.AF_INET,socket.SOCK_DGRAM).sendto(b'test',('1.1.1.1',53))),
 'vsockDenied':denied(lambda:socket.socket(40,socket.SOCK_STREAM)),
 'mountDenied':mount,'setnsDenied':setns,
 'uidUnprivileged':os.getuid()==1000,
 'capabilitiesEmpty':'CapEff:\\t0000000000000000' in pathlib.Path('/proc/self/status').read_text(),
 'nestedUsernsAllowed':subprocess.run(['/usr/bin/unshare','-Ur','true'],stderr=subprocess.DEVNULL).returncode==0,
 'dependencyReadOnly':not os.access('/usr/local/lib/starport',os.W_OK)
}))`);
  assert.equal(result.code,0,result.stderr);
  for(const [name,value] of Object.entries(JSON.parse(result.stdout)))assert.equal(value,true,name);
  const proxy=String.raw`import socket
s=socket.create_connection(('127.0.0.1',13128));s.settimeout(4);s.sendall(b'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n');print(s.recv(4096).decode())`;
  assert.match((await run(proxy)).stdout,/200 Connection/);
  e.pause();assert.match((await run(proxy)).stdout,/502 Bad/);
  e.resume();assert.match((await run(proxy)).stdout,/200 Connection/);
});
}
