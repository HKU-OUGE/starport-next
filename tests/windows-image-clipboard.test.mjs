import test from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {EventEmitter} from 'node:events';
import {spawnSync} from 'node:child_process';
import {clipboardDecoder,imageDimensions,MAX_IMAGE_BYTES,windowsImageClipboard} from '../packages/control/windows-image-clipboard.mjs';
import {createProjectRuntime} from '../packages/runtime/project.mjs';

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXs8AAAAASUVORK5CYII=','base64');
const frame=Buffer.concat([Buffer.from(JSON.stringify({kind:'image',sequence:17,bytes:png.length})+'\n'),png]);
test('clipboard decoder accepts fragmented PNG frames and rejects unbounded or non-image bodies',()=>{
  const received=[],decode=clipboardDecoder(f=>received.push(f));
  const bytes=Buffer.concat([Buffer.from('{"kind":"ready"}\n'),frame,Buffer.from('{"kind":"clear","sequence":18}\n')]);
  for(let i=0;i<bytes.length;i+=7)decode(bytes.subarray(i,i+7));
  assert.deepEqual(received.map(f=>f.kind),['ready','image','clear']);assert.deepEqual(received[1].png,png);
  assert.deepEqual(imageDimensions(png),{width:1,height:1});
  assert.throws(()=>clipboardDecoder(()=>{})(Buffer.from(JSON.stringify({kind:'image',bytes:MAX_IMAGE_BYTES+1})+'\n')),/clipboard_image_limit/);
  assert.throws(()=>clipboardDecoder(()=>{})(Buffer.alloc(513,65)),/clipboard_header_limit/);
  const huge=Buffer.from(png);huge.writeUInt32BE(32000001,16);assert.throws(()=>imageDimensions(huge),/clipboard_image_limit/);
  assert.throws(()=>imageDimensions(Buffer.from('file:///private/image.png')),/invalid_clipboard_image/);
});

for(const display of ['wslg','remote'])test(`${display} image delivery remains scoped to explicitly shared native sessions`,async()=>{
  const frames=[];
  const launch=()=>{const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    const emit=value=>child.stdout.write(JSON.stringify({type:'output',stream:'stdout',data:Buffer.from(JSON.stringify(value)+'\n').toString('base64')})+'\n');
    child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const f=JSON.parse(line);frames.push(f);if(f.workspace)setImmediate(()=>emit({kind:'native_ready'}));if(f.app==='clipboard-image'&&f.stage==='end')setImmediate(()=>emit({kind:'native_clipboard_result',id:f.id,applied:true}));}});
    child.stdin.on('finish',()=>child.emit('close',0));return child;};
  const runtime=createProjectRuntime('unused',{launch,capabilities:()=>({modelCapability:'sdk-test'}),destinations:{},wslg:true});
  try{await runtime.nativeAction('main','files',display);
    if(display==='remote')await assert.rejects(runtime.nativeImage('main',png),/wslg_clipboard_session_required/);
    else{await runtime.nativeImage('main',png);const messages=frames.filter(f=>f.app==='clipboard-image');assert.deepEqual(messages.map(f=>f.stage),['begin','chunk','end']);assert.deepEqual(Buffer.from(messages[1].data,'base64'),png);assert.ok(messages.every(f=>JSON.stringify(f).length<32768));await assert.rejects(runtime.nativeImage('other',png),/wslg_clipboard_session_required/);await assert.rejects(runtime.nativeImage('main',png,()=>false),/superseded/);}
    await assert.rejects(runtime.nativeAction('main','clipboard-image',display),/invalid_native_app/);
    assert.equal(frames[0].request.modelCapability,undefined);
  }finally{runtime.close();}
});

test('closing a native session rejects an in-flight image acknowledgement immediately',async()=>{
  let child,ended;
  const endSent=new Promise(resolve=>ended=resolve);
  const launch=()=>{child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
    child.stdin.on('data',chunk=>{for(const line of chunk.toString().trim().split('\n')){const f=JSON.parse(line);if(f.workspace)setImmediate(()=>child.stdout.write(JSON.stringify({type:'output',stream:'stdout',data:Buffer.from('{"kind":"native_ready"}\n').toString('base64')})+'\n'));if(f.app==='clipboard-image'&&f.stage==='end')ended();}});
    child.stdin.on('finish',()=>child.emit('close',0));return child;};
  const runtime=createProjectRuntime('unused',{launch,capabilities:()=>({}),destinations:{},wslg:true});
  try{await runtime.nativeAction('main','files','wslg');const sending=runtime.nativeImage('main',png);const rejected=assert.rejects(sending,/native_session_unavailable/);await endSent;runtime.close();await rejected;}
  finally{runtime.close();}
});

test('Windows listener runs only with WSLg sessions and closes when the last one stops',async()=>{
  let native=[],child,launches=0;const images=[];
  const runtime={status:()=>({native}),nativeImage:async(w,b)=>images.push([w,b])};
  const manager=windowsImageClipboard(runtime,{launch:(_exe,args,options)=>{launches++;assert.equal(options.windowsHide,true);assert.ok(args.includes('-STA'));child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>{};return child;}});
  try{
    native=[{workspace:'web',phase:'running',display:'remote'}];await new Promise(r=>setTimeout(r,450));assert.equal(launches,0);
    native.push({workspace:'main',phase:'running',display:'wslg'});await new Promise(r=>setTimeout(r,450));assert.equal(launches,1);
    child.stdout.write(Buffer.from('{"kind":"ready"}\n'));child.stdout.write(frame);await new Promise(r=>setImmediate(r));assert.equal(images.length,1);assert.equal(images[0][0],'main');assert.deepEqual(images[0][1],png);
    native=[];await new Promise(r=>setTimeout(r,450));assert.equal(child.stdin.writableEnded,true);assert.equal(manager.status().phase,'stopped');
  }finally{manager.close();}
});

const python=(process.platform==='win32'?['python','python3']:['python3','python']).find(p=>spawnSync(p,['--version']).status===0);
test('project receiver rejects corrupt, reordered, oversized and expired transfers without touching files',{skip:!python},()=>{
  const result=spawnSync(python,['-I','-B','-c',String.raw`
import importlib.util,base64,hashlib
s=importlib.util.spec_from_file_location('image','packages/wsl/image-clipboard.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
data=base64.b64decode('${png.toString('base64')}');id='a'*24
begin={'id':id,'stage':'begin','bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()}
chunk={'id':id,'stage':'chunk','offset':0,'data':base64.b64encode(data).decode()};end={'id':id,'stage':'end'}
t=m.ImageTransfer();t.accept(begin);t.accept(chunk);assert t.accept(end)==data;assert t.id is None and not t.data
for bad in [dict(chunk,offset=1),dict(chunk,data='!'),dict(chunk,data=base64.b64encode(data+b'x').decode()),end]:
 t.accept(begin)
 try:t.accept(bad);raise AssertionError('bad transfer accepted')
 except (ValueError,TypeError):pass
 assert t.id is None and not t.data
t.accept(begin);t.deadline=0
try:t.accept(chunk);raise AssertionError('expired transfer accepted')
except ValueError:pass
try:t.accept(dict(begin,bytes=m.MAX_BYTES+1));raise AssertionError('large transfer accepted')
except ValueError:pass
`],{encoding:'utf8'});assert.equal(result.status,0,result.stdout+result.stderr);
});
