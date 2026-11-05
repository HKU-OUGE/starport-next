import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {loadControlOptions} from '../packages/control/config.mjs';
import {snapshotControl} from '../packages/control/config-transfer.mjs';
import {validateConfig} from '../packages/config/model.mjs';
import {createProjectRuntime} from '../packages/runtime/project.mjs';
const python=(process.platform==='win32'?['python','python3']:['python3','python']).find(p=>{const r=spawnSync(p,['--version'],{encoding:'utf8'});return r.status===0&&/Python 3\./.test(r.stdout+r.stderr);});

test('clipboard sharing is explicit, survives portable export and does not enable WSLg',t=>{
  const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-clipboard-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const file=path.join(dir,'host.json'),host={format:'starport-host-control',version:1,runtime:{kind:'qemu',state:'vm'},seamless:true};
  fs.writeFileSync(file,JSON.stringify(host));assert.equal(loadControlOptions(file).seamlessClipboard,'disabled');
  host.seamlessClipboard='text';fs.writeFileSync(file,JSON.stringify(host));
  const options=loadControlOptions(file);assert.equal(options.seamlessClipboard,'text');assert.equal(options.wslg,false);
  const exported=snapshotControl(file).value.config;assert.equal(exported.workspace.seamlessClipboard,'text');validateConfig(exported);
  for(const bad of ['all','images',true,null,'']){host.seamlessClipboard=bad;fs.writeFileSync(file,JSON.stringify(host));assert.throws(()=>loadControlOptions(file),/invalid_clipboard_mode/);}
  const r=createProjectRuntime(dir,{launch:()=>{},...options});assert.equal(r.status().clipboard,'bidirectional-text');r.close();
});

test('clipboard transfers preserve multilingual text and reject images, rich text, files and PRIMARY',{skip:!python},()=>{
  const r=spawnSync(python,['-X','utf8','-I','-B','-c',String.raw`
import importlib.util
s=importlib.util.spec_from_file_location('policy','packages/wsl/xpra-clipboard.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
value='測試 / 测试 / English\nprint("a_123")'.encode('utf8')
for kind in ['clipboard-contents','clipboard-token']:
 p=[kind,7,'CLIPBOARD','UTF8_STRING',8,'bytes',value] if kind=='clipboard-contents' else [kind,'CLIPBOARD',['UTF8_STRING'],'UTF8_STRING','UTF8_STRING',8,'bytes',value,True,False]
 assert m.incoming(p)==p
 assert p[-1] is False or p[-1]==value
for format in ['image/png','text/html','text/uri-list','x-special/gnome-copied-files']:
 assert m.incoming(['clipboard-contents',1,'CLIPBOARD',format,8,'bytes',b'private'])==['clipboard-contents-none',1,'CLIPBOARD']
 p=m.incoming(['clipboard-token','CLIPBOARD',[format,'UTF8_STRING'],format,format,8,'bytes',b'private',True,False])
 assert p[2]==['UTF8_STRING'] and p[3]=='' and b'private' not in p
assert m.incoming(['clipboard-token','PRIMARY',['UTF8_STRING']]) is None
assert m.incoming(['clipboard-enable-selections',['PRIMARY','SECONDARY','CLIPBOARD']])[1]==['CLIPBOARD']
p=m.incoming(['clipboard-contents',1,'CLIPBOARD','ATOM',32,'atoms',['image/png','TARGETS','UTF8_STRING']]);assert p[6]==['TARGETS','UTF8_STRING']
# A target claiming to be text cannot smuggle a different payload type.
p=m.incoming(['clipboard-token','CLIPBOARD',['UTF8_STRING'],'UTF8_STRING','image/png',8,'bytes',b'image']);assert p[3]==''
print('passed')
`],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
});

test('the neutral display client copies only its selected display authorization and rejects missing cookies',{skip:!python},()=>{
  const r=spawnSync(python,['-X','utf8','-I','-B','-c',String.raw`
import importlib.util,tempfile,pathlib,subprocess,os
from unittest.mock import patch
s=importlib.util.spec_from_file_location('viewer','packages/linux/seamless-client.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 target=pathlib.Path(d)/'Xauthority'
 values=[subprocess.CompletedProcess([],0,'0100 0001 61 0001 30 0001 61 0001 62\n',''),subprocess.CompletedProcess([],0,'','')]
 with patch.object(m.subprocess,'run',side_effect=values) as run:
  assert m.display_authority(pathlib.Path(d)/'source',target,':17')==target
  assert run.call_args_list[0].args[0][-2:]==['nlist',':17']
  assert run.call_args.kwargs['input'].startswith('ffff ')
  if os.name!='nt':assert target.stat().st_mode&0o077==0
 with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'','')):
  try:m.display_authority(target,target,':18');raise AssertionError('missing authorization accepted')
  except ValueError:pass
`],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
});
