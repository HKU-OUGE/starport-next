import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {pipeBridge} from '../packages/control/pipe-bridge.mjs';

function fixture(t){
  const child=new EventEmitter();child.stdin=new PassThrough();child.stdout=new PassThrough();child.stderr=new PassThrough();
  const events=[],frames=[],peers=[];child.stdin.on('data',b=>frames.push(...b.toString().trim().split('\n').map(JSON.parse)));
  const bridge=pipeBridge(child,{}, {onEvent:e=>events.push(e),onChannel:()=>{
    const p=new EventEmitter();p.writableLength=0;p.setTimeout=()=>{};p.pause=()=>{};p.resume=()=>{};p.write=()=>true;
    p.destroy=()=>{p.destroyed=true;queueMicrotask(()=>p.emit('close'));};peers.push(p);return p;
  }});t.after(()=>bridge.close());
  return {child,events,frames,peers,send:v=>child.stdout.write(JSON.stringify(v)+'\n')};
}
test('rapid connection replacement frees its slot before the asynchronous close event',async t=>{
  const f=fixture(t);for(let id=1;id<=48;id++)f.send({type:'open',channel:'proxy',id});
  f.send({type:'close',id:1});f.send({type:'open',channel:'proxy',id:49});
  await new Promise(r=>setImmediate(r));assert.equal(f.peers.length,49);assert.equal(f.child.stdin.writableEnded,false);assert.equal(f.events.some(e=>e.type==='disconnected'),false);
});
test('channel capacity rejects one connection without ending a graphical session',t=>{
  const f=fixture(t);for(let id=1;id<=49;id++)f.send({type:'open',channel:'proxy',id});
  assert.equal(f.peers.length,48);assert.equal(f.child.stdin.writableEnded,false);assert.ok(f.frames.some(v=>v.type==='close'&&v.id===49));
  f.send({type:'close',id:1});f.send({type:'open',channel:'proxy',id:50});assert.equal(f.peers.length,49);
});
test('a saturated peer cannot close the native control pipe',t=>{
  const f=fixture(t);f.send({type:'open',channel:'proxy',id:1});f.send({type:'open',channel:'proxy',id:2});
  f.peers[0].writableLength=2*1024*1024;f.send({type:'data',id:1,data:'eA=='});
  assert.equal(f.peers[0].destroyed,true);assert.ok(!f.peers[1].destroyed);assert.equal(f.child.stdin.writableEnded,false);
});

test('a slow WSL data sink closes only its source channel and reserves control capacity',t=>{
  const f=fixture(t);f.send({type:'open',channel:'proxy',id:1});f.send({type:'open',channel:'proxy',id:2});
  Object.defineProperty(f.child.stdin,'writableLength',{value:4*1024*1024+1,configurable:true});
  f.peers[0].emit('data',Buffer.from('reply'));
  assert.equal(f.peers[0].destroyed,true);assert.ok(!f.peers[1].destroyed);assert.equal(f.child.stdin.writableEnded,false);
  assert.ok(f.frames.some(v=>v.type==='close'&&v.id===1));
});
test('late viewer connection refusal does not close applications, but invalid protocol still does',t=>{
  const p=new EventEmitter();p.stdin=new PassThrough();p.stdin.resume();p.stdout=new PassThrough();p.stderr=new PassThrough();
  const bridge=pipeBridge(p,{}, {onChannel:()=>undefined});t.after(()=>bridge.close());
  p.stdout.write(JSON.stringify({type:'open',channel:'viewer',id:1})+'\n');assert.equal(p.stdin.writableEnded,false);
  p.stdout.write(JSON.stringify({type:'open',channel:'management',id:2})+'\n');assert.equal(p.stdin.writableEnded,true);
});
