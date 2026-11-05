import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {spawnSync} from 'node:child_process';
import {createProjectRuntime} from '../packages/runtime/project.mjs';

test('display comparison requires WSLg and reuses its scoped native session',async()=>{
  const frames=[];let launches=0;
  const launch=()=>{
    launches++;const child=new EventEmitter();
    child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){
      const frame=JSON.parse(line);frames.push(frame);
      if(frame.workspace)setImmediate(()=>child.stdout.write(JSON.stringify({type:'output',stream:'stdout',data:Buffer.from('{"kind":"native_ready"}\n').toString('base64')})+'\n'));
    }});
    child.stdin.on('finish',()=>child.emit('close',0));return child;
  };
  const runtime=createProjectRuntime('unused',{launch,capabilities:()=>({}),destinations:{},wslg:true,seamless:true});
  try{
    for(const display of ['remote','seamless'])await assert.rejects(runtime.nativeAction('main','display-compare',display),/display_comparison_requires_wslg/);
    assert.equal(launches,0);
    await runtime.nativeAction('main','browser','wslg');
    await runtime.nativeAction('main','display-compare','wslg');
    assert.equal(launches,1);
    assert.equal(frames.filter(f=>f.app==='display-compare').length,1);
    await assert.rejects(runtime.nativeAction('main','compare-wayland;command','wslg'),/invalid_native_app/);
  }finally{runtime.close();}
});

const python=(process.platform==='win32'?['python','python3']:['python3','python']).find(name=>spawnSync(name,['--version']).status===0);
test('comparison launches distinct sandboxed profiles and preserves default X11 clients',{skip:!python},()=>{
  const result=spawnSync(python,['-X','utf8','-I','-B','-c',String.raw`
import ast,io,os,pathlib,subprocess,types
source=ast.parse(pathlib.Path('packages/wsl/native-session.py').read_text())
function=next(n for n in source.body if isinstance(n,ast.FunctionDef) and n.name=='launch')
calls=[]
def popen(argv,**kwargs):
 calls.append((argv,kwargs));return types.SimpleNamespace(poll=lambda:None)
context={'remote':False,'apps':{},'os':os,'shutil':types.SimpleNamespace(which=lambda _:True),
 'subprocess':types.SimpleNamespace(Popen=popen,DEVNULL=subprocess.DEVNULL),
 'open':lambda *args,**kwargs:io.StringIO(),'report':lambda:None}
exec(compile(ast.Module(body=[function],type_ignores=[]),'native-launch','exec'),context)
context['launch']('display-compare');context['launch']('display-compare')
assert len(calls)==2
profiles=[]
for backend,(argv,options) in zip(['x11','wayland'],calls):
 assert '--ozone-platform='+backend in argv
 profile=next(arg for arg in argv if arg.startswith('--user-data-dir='));profiles.append(profile)
 assert profile=='--user-data-dir=/home/agent/.config/starport-compare-'+backend
 assert '--proxy-server=http://127.0.0.1:13128' in argv and '--no-sandbox' not in argv
 assert '--app=file:///opt/starport/ime-check.html?backend='+backend in argv
 assert options['cwd']=='/workspace' and options['env']['ELECTRON_OZONE_PLATFORM_HINT']==backend
assert profiles[0]!=profiles[1]
context['launch']('browser');context['launch']('desktop')
assert all('--ozone-platform=x11' in argv for argv,_ in calls[2:])
context['remote']=True
try:context['launch']('display-compare');raise AssertionError('remote comparison accepted')
except ValueError as exc:assert str(exc)=='display_comparison_unavailable'
`],{encoding:'utf8'});
  assert.equal(result.status,0,result.stdout+result.stderr);
});
