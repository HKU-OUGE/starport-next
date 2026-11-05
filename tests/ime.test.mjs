import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createProjectRuntime,publicIme} from '../packages/runtime/project.mjs';

test('IME status exposes only bounded state and never private bus addresses or input text',()=>{
  const r=publicIme({phase:'ready',mode:'traditional',privateBus:'unix:path=/secret',composition:'private input',error:'sensitive value',hotkey:'Shell;command'});
  assert.equal(r.phase,'ready');assert.equal(r.hotkey,'Control+space');assert.equal(r.error,null);
  assert.equal(JSON.stringify(r).includes('secret'),false);assert.equal(JSON.stringify(r).includes('private input'),false);
});
test('IME actions require an existing project, acknowledge its own request and reject command injection',async()=>{
  const frames=[],children=[];
  const launch=()=>{
    const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    const output=v=>child.stdout.write(JSON.stringify({type:'output',stream:'stdout',data:Buffer.from(JSON.stringify(v)+'\n').toString('base64')})+'\n');
    child.stdin.on('data',b=>{for(const line of b.toString().trim().split('\n')){const v=JSON.parse(line);frames.push(v);if(v.workspace)setImmediate(()=>output({kind:'native_ready',ime:{phase:'ready'}}));if(v.app==='ime')setImmediate(()=>output({kind:'native_ime_result',id:v.id,ime:{phase:'ready',mode:v.action}}));}});
    child.stdin.on('finish',()=>child.emit('close',0));children.push(child);return child;
  };
  const r=createProjectRuntime('unused',{launch,capabilities:()=>({}),destinations:{},wslg:true});
  await assert.rejects(r.imeAction('main','restart'),/native_session_unavailable/);
  await r.nativeAction('main','browser');await r.nativeAction('other','browser');
  const answer=await r.imeAction('main','simplified');assert.equal(answer.mode,'simplified');assert.equal(r.status().native.find(n=>n.workspace==='other').ime.mode,null);
  await assert.rejects(r.imeAction('main','shell'),/invalid_ime_action/);
  await assert.rejects(r.imeAction('main','settings',{hotkey:'Control+space',rememberWindows:true,command:'env'}),/invalid_ime_settings/);
  const request=frames.find(v=>v.app==='ime');assert.match(request.id,/^[a-f0-9]{24}$/);
  assert.equal(frames.filter(v=>v.app==='ime').length,1);r.close();
});
test('IME preferences preserve explicit edits, isolate XIM names and keep traditional schema first',{skip:process.platform!=='linux'},()=>{
  const r=spawnSync('python3',['-I','-B','-c',String.raw`
import importlib.util,pathlib,tempfile,json
s=importlib.util.spec_from_file_location('ime','packages/wsl/ime.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 root,settings=m.prepare(d)
 assert settings['hotkey']=='Control+space'
 schemas=(root/'data/fcitx5/rime/default.custom.yaml').read_text()
 assert schemas.index('starport_pinyin_tw')<schemas.index('starport_pinyin_simp')
 tw=(root/'data/fcitx5/rime/starport_pinyin_tw.schema.yaml').read_text()
 assert 't2tw.json' in tw and 'enable_user_dict: false' in tw
 assert m.InputMethod(d).xim!=m.InputMethod(d).xim
 profile=root/'config/fcitx5/profile'
 original=profile.read_text();profile.write_text('# Fcitx generated comment\n'+original.replace('\n','\n\n'))
 m.prepare(d);assert profile.read_text().startswith('# Fcitx')
 prefs=root/'preferences.json';prefs.write_text(json.dumps({'hotkey':'Control+Shift+space','rememberWindows':True}))
 m.prepare(d);assert 'Control+Shift+space' in (root/'data/fcitx5/rime/starport_pinyin_tw.schema.yaml').read_text()
 file=root/'data/fcitx5/rime/starport_pinyin_tw.schema.yaml';file.write_text('explicit local edit')
 try:m.prepare(d);raise AssertionError('changed configuration overwritten')
 except ValueError as e:assert str(e)=='ime_configuration_changed'
for value in [{'hotkey':'bad'}, {'rememberWindows':'yes'}, {'command':'id'}]:
 try:m.preferences(value);raise AssertionError('invalid settings accepted')
 except ValueError:pass
print('passed')
`],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
});

test('IME probes never auto-activate an unconfigured daemon and absent input context is explicit',{skip:process.platform!=='linux'},()=>{
  const r=spawnSync('python3',['-I','-B','-c',String.raw`
import importlib.util,subprocess
from unittest.mock import patch
s=importlib.util.spec_from_file_location('ime','packages/wsl/ime.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
i=m.InputMethod('/tmp/example',{'DBUS_SESSION_BUS_ADDRESS':'private-test-bus'})
with patch.object(m.subprocess,'run',return_value=subprocess.CompletedProcess([],0,'(false,)','')) as run:
 try:i.call('ListAllSchemas',rime=True);raise AssertionError('started absent service')
 except ValueError as e:assert str(e)=='ime_bus_unavailable'
 assert run.call_count==1 and 'org.freedesktop.DBus.NameHasOwner' in run.call_args.args[0]
i.phase='ready'
with patch.object(i,'call',return_value="('',)") as call:
 try:i.action('traditional');raise AssertionError('changed absent input context')
 except ValueError as e:assert str(e)=='ime_focus_required'
 assert call.call_count==1 and call.call_args.args[0]=='GetCurrentSchema'
`],{encoding:'utf8'});assert.equal(r.status,0,r.stdout+r.stderr);
});
