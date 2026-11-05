import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
const python=(process.platform==='win32'?['python','python3']:['python3','python']).find(p=>{const r=spawnSync(p,['--version'],{encoding:'utf8'});return r.status===0&&/Python 3\./.test(r.stdout+r.stderr);});

test('display diagnostics report process identity and explicit Ozone mode without command lines or log contents',{skip:!python},()=>{
 const r=spawnSync(python,['-X','utf8','-I','-B','-c',String.raw`
import importlib.util,tempfile,pathlib,json
s=importlib.util.spec_from_file_location('probe','packages/wsl/display-diagnostic.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
assert m.requested_ozone(['chrome','--ozone-platform=wayland'])=='wayland'
assert m.requested_ozone(['chrome','--ozone-platform=wayland','--ozone-platform=x11'])=='x11'
assert m.requested_ozone(['chrome','--ozone-platform','auto'])=='auto'
assert m.requested_ozone(['chrome','https://private.example/secret'])=='unspecified'
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d).resolve();base=root/'workspaces';code=root/'runtime';proc=root/'proc';wslg=root/'wslg'
 for p in [base/'main/project',code,proc,wslg]:p.mkdir(parents=True,exist_ok=True)
 (code/'owner').write_text('a'*64);(wslg/'versions.txt').write_text('WSLg ( x86_64 ): 1.0.71+PrivateBuild')
 log=wslg/'weston.log';log.write_text('private.example secret-token user-name\nRDP disconnected\n',encoding='utf8')
 request={'workspace':'main','owner':'a'*64};result=m.collect(request,base=base,code=code,proc=proc,wslg=wslg)
 assert result['logSignals']['weston.log']['displayDisconnect'] is True
 assert result['wslgVersion']=='1.0.71' and result['browsers']==[]
 text=json.dumps(result);assert all(v not in text for v in ['secret-token','private.example','PrivateBuild','user-name'])
 for bad in [{'workspace':'../other','owner':'a'*64},{'workspace':'main','owner':'b'*64}]:
  try:m.collect(bad,base=base,code=code,proc=proc,wslg=wslg);raise AssertionError('scope bypass')
  except ValueError:pass
 # An actual /proc-style root mapping is tested where symlinks are supported.
 try:
  p=proc/'42';(p/'root').mkdir(parents=True);(p/'root/workspace').symlink_to(base/'main/project',target_is_directory=True)
 except OSError:pass
 else:
  fields=['S']+['0']*18+['12345']
  (p/'stat').write_text('42 (chrome) '+' '.join(fields))
  (p/'cmdline').write_bytes(b'/opt/google/chrome/chrome\0--ozone-platform=wayland\0https://private.example/secret\0')
  result=m.collect(request,base=base,code=code,proc=proc,wslg=wslg)
  assert result['browsers']==[{'pid':42,'startTicks':12345,'requestedOzone':'wayland'}]
  assert 'private.example' not in json.dumps(result)
print('passed')
`],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
});
