import crypto from 'node:crypto';
import {error} from '../runtime/common.mjs';

export const attachmentLimit=64*1024*1024;
const hash=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
export function validateUpload(input){
  const {requestId,name,data,sha256}=input||{};
  if(!/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(requestId||''))throw error('invalid_request_id');
  if(typeof name!=='string'||!name||Buffer.byteLength(name)>240||/[\\/\x00-\x1f\x7f]/.test(name)||['.','..'].includes(name))throw error('invalid_attachment_name');
  if(typeof data!=='string'||data.length>Math.ceil(attachmentLimit/3)*4||/[^A-Za-z0-9+/=]/.test(data))throw error('invalid_attachment_data');
  const bytes=Buffer.from(data,'base64');
  if(bytes.toString('base64')!==data)throw error('invalid_attachment_data');
  if(bytes.length>attachmentLimit||hash(bytes)!==sha256)throw error('file_integrity_mismatch');
  return {id:requestId,name,sha256,bytes:bytes.length};
}
export function resolveAttachments(row,ids=[]){
  if(!Array.isArray(ids)||ids.length>8||new Set(ids).size!==ids.length)throw error('invalid_attachments');
  const found=ids.map(id=>{const file=row.attachments?.find(f=>f.id===id&&f.ready);if(!file)throw error('attachment_not_found');return file;});
  if(found.reduce((sum,f)=>sum+f.bytes,0)>128*1024*1024)throw error('attachments_too_large');
  return found.map(({id,name,path,sha256,bytes})=>({id,name,path,sha256,bytes}));
}
