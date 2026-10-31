import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createWslRuntime } from '../packages/wsl/runtime.mjs';
import { createEgress } from '../packages/runtime/egress.mjs';
import { fixture } from './wsl-fixture.mjs';

const supported=process.platform==='linux'&&fs.existsSync('/usr/bin/bwrap')&&spawnSync('unshare',['-Urn','true']).status===0;
test('real Linux namespace: host files and network absent, project files writable from control, proxy pipe fail-closed', {skip:!supported,timeout:60000},async t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-wsl-proof-'));
  const upstream=http.createServer();upstream.on('connect',(_req,s)=>{s.write('HTTP/1.1 200 Connection Established\r\n\r\n');s.on('data',b=>s.write(b));});
  await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));
  const e=await createEgress({upstream:{kind:'http',url:`http://127.0.0.1:${upstream.address().port}`},hosts:['example.com']});
  const r=createWslRuntime(dir,{launch:fixture(dir),destinations:{proxy:e.proxyPort,model:e.apiPort,compute:e.apiPort},capabilities:()=>({modelCapability:e.capability,computeCapability:'example-scoped-token'})});
  t.after(()=>{r.close();e.close();upstream.closeAllConnections();upstream.close();fs.rmSync(dir,{recursive:true,force:true});});
  const run=script=>r.execute('main',{operation:'exec',argv:['/usr/bin/python3','-I','-c',script]});
  const probe=await run(`import os,json,socket,pathlib,subprocess
def direct(h,p):
 try: socket.create_connection((h,p),timeout=0.5); return True
 except OSError:return False
print(json.dumps({'host':socket.gethostname(),'lang':os.environ['LANG'],'tz':os.environ['TZ'],'uid':os.getuid(),'windows':pathlib.Path('/mnt/c').exists(),'admin':pathlib.Path('/root/.ssh').exists(),'owner':pathlib.Path('/opt/starport/owner').exists(),'route':pathlib.Path('/proc/net/route').read_text(),'tcp':direct('1.1.1.1',443),'metadata':direct('169.254.169.254',80),'ipv6':direct('2606:4700:4700::1111',443),'caps':next(x for x in pathlib.Path('/proc/self/status').read_text().splitlines() if x.startswith('CapEff:')),'userns':subprocess.run(['/usr/bin/unshare','-Ur','true'],stderr=subprocess.DEVNULL).returncode}))`);
  assert.equal(probe.code,0,probe.stderr);const p=JSON.parse(probe.stdout);assert.equal(p.host,'starship');assert.equal(p.lang,'zh_TW.UTF-8');assert.equal(p.tz,'Asia/Taipei');assert.equal(p.uid,1000);
  for(const field of ['windows','admin','owner','tcp','metadata','ipv6'])assert.equal(p[field],false,field);
  assert.equal(p.route.trim().split('\n').length,1);assert.match(p.caps,/0000000000000000/);assert.notEqual(p.userns,0);
  assert.equal((await run("print('繁體中文' * 9000, end='')")).stdout,'繁體中文'.repeat(9000));
  const original=Buffer.from('臺北繁體中文\nproject-bytes\n'),sha256=crypto.createHash('sha256').update(original).digest('hex');
  const file=async q=>{const v=await r.execute('main',{operation:'files',request:q});return {code:v.code,...JSON.parse(v.stdout)};};
  assert.equal((await file({operation:'write',path:'check.txt',data:original.toString('base64'),sha256})).code,0);
  assert.equal((await file({operation:'read',path:'check.txt'})).sha256,sha256);
  assert.equal((await file({operation:'rename',path:'check.txt',destination:'renamed.txt'})).renamed,true);
  assert.equal((await file({operation:'read',path:'../../etc/passwd'})).error,'invalid_project_path');
  await run("import pathlib; pathlib.Path('/workspace/escape').symlink_to('/etc/passwd')");
  assert.equal((await file({operation:'read',path:'escape'})).error,'project_symlink_rejected');
  const proxy=String.raw`import socket
s=socket.create_connection(('127.0.0.1',13128));s.settimeout(4);s.sendall(b'CONNECT example.com:443 HTTP/1.1\r\nHost: example.com\r\n\r\n');print(s.recv(4096).decode())`;
  assert.match((await run(proxy)).stdout,/200 Connection/);e.pause();assert.match((await run(proxy)).stdout,/502 Bad/);e.resume();assert.match((await run(proxy)).stdout,/200 Connection/);
  assert.equal((await file({operation:'delete',path:'renamed.txt'})).deleted,true);
});
