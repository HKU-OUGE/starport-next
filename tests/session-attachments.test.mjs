import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {validateUpload,resolveAttachments} from '../packages/control/session-attachments.mjs';
import {initAttachments} from '../packages/control/web/session-attachments.js';

test('upload validates names, canonical base64, size and digest before dispatch',()=>{
  const input={requestId:crypto.randomUUID(),name:'report.pdf',data:'eA==',sha256:crypto.createHash('sha256').update('x').digest('hex')};
  assert.equal(validateUpload(input).bytes,1);
  for(const name of ['../escape','/etc/passwd','a\\b','a\nb','..'])assert.throws(()=>validateUpload({...input,name}));
  for(const data of ['eA','eA==\n','eB=='])assert.throws(()=>validateUpload({...input,data}));
  assert.throws(()=>validateUpload({...input,sha256:'wrong'}),/file_integrity/);
  assert.throws(()=>resolveAttachments({},['unknown']),/attachment_not_found/);
  assert.throws(()=>resolveAttachments({attachments:[{id:'a',ready:true,bytes:1}]},['a','a']),/invalid_attachments/);
  const large=Buffer.alloc(2*1024*1024,1);assert.equal(validateUpload({...input,data:large.toString('base64'),sha256:crypto.createHash('sha256').update(large).digest('hex')}).bytes,large.length);
});

test('drop batches remain with their original session while the user switches; draft removal does not delete project files',async t=>{
  const originals={document:globalThis.document,sessionStorage:globalThis.sessionStorage},elements=new Map(),storage=new Map(),errors=[],calls=[];
  const element=()=>({children:[],handlers:{},classList:{add(){},remove(){}},contains(){return false;},addEventListener(k,fn){this.handlers[k]=fn;},setAttribute(){},append(...nodes){this.children.push(...nodes);},replaceChildren(...nodes){this.children=nodes;}});
  globalThis.document={getElementById:id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id);}};
  globalThis.sessionStorage={getItem:k=>storage.get(k),setItem:(k,v)=>storage.set(k,v)};
  t.after(()=>Object.assign(globalThis,originals));
  let current={id:'first',locked:false},read;
  const data=new Promise(resolve=>{read=resolve;});
  const view=initAttachments({session:()=>current,api:async(route,q)=>{calls.push({route,q});return {id:q.requestId,name:q.name,ready:true,bytes:1};},el:()=>element(),problem:e=>errors.push(e),change(){}});
  elements.get('session-drop').handlers.drop({preventDefault(){},dataTransfer:{items:[],files:[{name:'a.txt',size:1,arrayBuffer:()=>data}]}});
  assert.equal(view.blocked('first'),true);current={id:'second',locked:false};read(new Uint8Array([120]).buffer);
  for(let i=0;i<20&&!calls.length;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(calls[0].route,'/api/sessions/first/attachments');assert.deepEqual(view.ids('second'),[]);assert.equal(view.ids('first').length,1);
  const ids=view.ids('first');view.clear('first',ids);assert.deepEqual(view.ids('first'),[]);assert.equal(calls.length,1);assert.deepEqual(errors,[]);
});

test('guest attachment storage and server-side web fetch validation',()=>{
  const result=execFileSync('python',['-X','utf8','-m','unittest','discover','-s','tests','-p','test_web_upload.py'],{encoding:'utf8',stdio:'pipe'});
  assert.equal(typeof result,'string');
});
