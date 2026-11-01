import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import {EventEmitter} from 'node:events';
import {availableProxyPort} from '../packages/runtime/managed-proxy.mjs';

test('proxy allocation escapes sequential TCP ports in a UDP-reserved range',async t=>{
  const candidates=[];let tcpAttempts=0;
  t.mock.method(net,'createServer',()=>Object.assign(new EventEmitter(),{
    listening:false,port:null,
    listen(candidate,host,ready){candidates.push(candidate);this.port=candidate||57053;
      // One random candidate is occupied by another TCP listener; retry it too.
      if(++tcpAttempts===2){queueMicrotask(()=>this.emit('error',Error('EADDRINUSE')));return;}
      this.listening=true;queueMicrotask(ready);},
    address(){return {port:this.port};},close(done){this.listening=false;done();}
  }));
  t.mock.method(dgram,'createSocket',()=>Object.assign(new EventEmitter(),{
    bind(port,host,ready){queueMicrotask(()=>port===57053?this.emit('error',Error('EACCES')):ready());},close(done){done();}
  }));
  const port=await availableProxyPort();assert.equal(candidates[0],0);
  assert.ok(candidates.slice(1).every(p=>p>=10240&&p<=65535));assert.equal(port,candidates.at(-1));assert.ok(candidates.length>=3);
});

test('mixed proxy allocation releases a port usable by both TCP and UDP',async()=>{
  const port=await availableProxyPort();
  assert.ok(Number.isInteger(port)&&port>0&&port<65536);
  const tcp=net.createServer(),udp=dgram.createSocket('udp4');
  try{
    await new Promise((resolve,reject)=>{tcp.once('error',reject);tcp.listen(port,'127.0.0.1',resolve);});
    await new Promise((resolve,reject)=>{udp.once('error',reject);udp.bind(port,'127.0.0.1',resolve);});
  }finally{
    await new Promise(resolve=>{try{udp.close(resolve);}catch{resolve();}});
    if(tcp.listening)await new Promise(resolve=>tcp.close(resolve));
  }
});
