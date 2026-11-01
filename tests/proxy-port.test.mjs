import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import dgram from 'node:dgram';
import {availableProxyPort} from '../packages/runtime/managed-proxy.mjs';

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
