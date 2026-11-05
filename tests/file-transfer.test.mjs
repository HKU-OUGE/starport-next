import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {uploadFiles,bindFileDrop} from '../packages/control/web/file-transfer.js';
const digest=async b=>crypto.createHash('sha256').update(b).digest('hex');
const file=(name,value)=>({name,size:Buffer.byteLength(value),arrayBuffer:async()=>new Uint8Array(Buffer.from(value)).buffer});
test('batch upload pins workspace and folder, verifies bytes, and asks before overwriting',async()=>{
 const writes=[],opts={workspace:'main',directory:'images',digest,write:async(id,q)=>writes.push({id,...q}),confirmOverwrite:async()=>false,existing:['old.png']};
 assert.equal(await uploadFiles([file('old.png','old'),file('new.png','新图')],opts),1);
 assert.equal(writes[0].id,'main');assert.equal(writes[0].path,'images/new.png');assert.equal(Buffer.from(writes[0].data,'base64').toString(),'新图');assert.equal(writes[0].sha256,await digest(Buffer.from('新图')));
});
test('invalid batch fails before writing any files',async()=>{
 let calls=0;const opts={workspace:'main',directory:'',digest,write:async()=>calls++,confirmOverwrite:async()=>true};
 await assert.rejects(uploadFiles([file('safe','x'),file('../escape','x')],opts));assert.equal(calls,0);
 await assert.rejects(uploadFiles([{...file('large','x'),size:65*1024*1024}],opts));assert.equal(calls,0);
});
test('drop handles files only and refuses directories without following their paths',async()=>{
 const handlers={},errors=[],uploads=[];const element={addEventListener:(k,v)=>handlers[k]=v,classList:{add(){},remove(){}},contains:()=>false};
 bindFileDrop(element,async f=>uploads.push(f),e=>errors.push(e.message));
 handlers.drop({preventDefault(){},dataTransfer:{items:[{webkitGetAsEntry:()=>({isDirectory:true})}],files:[file('folder','')]}});
 assert.equal(uploads.length,0);assert.equal(errors.length,1);
 handlers.drop({preventDefault(){},dataTransfer:{items:[],files:[file('picture.png','data')]}});await Promise.resolve();assert.equal(uploads.length,1);
});
