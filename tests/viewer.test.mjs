import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {WebSocket} from 'ws';
import {createViewer,viewerAsset} from '../packages/control/viewer.mjs';
import {createAccess} from '../packages/control/access.mjs';

test('viewer assets only serve noVNC modules inside the package',()=>{
  assert.match(viewerAsset('/novnc/core/rfb.js').toString(),/class RFB/);
  for(const name of ['/novnc/core/../../../package.json','/novnc/core/../core/rfb.js','/novnc/package.json','/novnc/core/missing.js'])assert.throws(()=>viewerAsset(name));
});

test('viewer requires origin, authentication and a single-use project/identity ticket',async t=>{
  const server=http.createServer();await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const port=server.address().port,origin=`http://127.0.0.1:${port}`,access=createAccess({port,key:'example-key'});let attached=0;
  const viewer=createViewer(server,{access:()=>access,verify:id=>assert.equal(id,'main'),runtime:{attachViewer:(_id,stream)=>{attached++;stream.on('error',()=>{});stream.on('data',data=>stream.write(data));}}});
  t.after(()=>{viewer.close();server.closeAllConnections();server.close();});
  const cookie='starport_control='+access.cookie;
  const request=(ticket,{path='main',headers={Origin:origin,Cookie:cookie}}={})=>new Promise(resolve=>{
    const ws=new WebSocket(`ws://127.0.0.1:${port}/api/workspaces/${path}/viewer?ticket=${ticket}`,{headers});
    ws.once('open',()=>resolve(ws));ws.once('unexpected-response',(_req,res)=>{res.resume();ws.terminate();resolve(res.statusCode);});ws.on('error',()=>{});
  });
  // Authentication's identity, not the literal cookie, binds the ticket.
  const identity=await access.authenticate({headers:{cookie},socket:{remoteAddress:'127.0.0.1'}},{mode:'local'});
  assert.equal(await request(viewer.ticket('main',identity).ticket,{headers:{Origin:origin}}),403);
  assert.equal(await request(viewer.ticket('main',identity).ticket,{headers:{Origin:'https://evil.example.com',Cookie:cookie}}),403);
  assert.equal(await request(viewer.ticket('main',identity).ticket,{path:'other'}),403);
  assert.equal(await request(viewer.ticket('main','other-identity').ticket),403);
  const ticket=viewer.ticket('main',identity).ticket,ws=await request(ticket);assert.equal(attached,1);
  const echo=new Promise(resolve=>ws.once('message',resolve));ws.send(Buffer.from('RFB test'));assert.equal((await echo).toString(),'RFB test');
  ws.close();assert.equal(await request(ticket),403);
});
