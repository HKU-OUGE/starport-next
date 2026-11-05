import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {pipeline} from 'node:stream/promises';
import {createGunzip} from 'node:zlib';
import {error,hash,privateDir,read,run,writePrivate} from '../runtime/common.mjs';
const vendors=JSON.parse(fs.readFileSync(new URL('./vendors.json',import.meta.url),'utf8'));
export async function downloadVerified(url,destination,sha256,{progress=()=>{},fetcher=fetch,maxBytes=256*1024*1024}={}){
  if(!/^https:\/\//.test(url)||!/^[a-f0-9]{64}$/.test(sha256))throw error('invalid_download_source');
  if(fs.existsSync(destination)&&await hash(destination)===sha256)return destination;
  const partial=destination+'.partial';
  for(let attempt=0;attempt<3;attempt++){
    let have=fs.existsSync(partial)?fs.statSync(partial).size:0;
    if(have>maxBytes)throw error('download_too_large');
    try{
      const r=await fetcher(url,{headers:have?{Range:`bytes=${have}-`}:{},signal:AbortSignal.timeout(300000)});
      if(r.status===416){if(await hash(partial)===sha256){fs.renameSync(partial,destination);return destination;}fs.rmSync(partial);continue;}
      if(!r.ok)throw error('download_http_error');
      if(have&&r.status===206&&!new RegExp('^bytes '+have+'-').test(r.headers.get('content-range')||''))throw error('download_range_mismatch');
      if(r.status!==206)have=0;
      const total=Number(r.headers.get('content-length')||0)+have;if(total>maxBytes)throw error('download_too_large');
      const file=fs.openSync(partial,have?'a':'w',0o600);let last=0;
      try{for await(const chunk of r.body){have+=chunk.length;if(have>maxBytes)throw error('download_too_large');fs.writeSync(file,chunk);if(Date.now()-last>300){progress({bytes:have,total});last=Date.now();}}}finally{fs.closeSync(file);}
      if(await hash(partial)!==sha256){fs.rmSync(partial);throw error('download_checksum_mismatch');}
      fs.renameSync(partial,destination);progress({bytes:have,total:have});return destination;
    }catch(e){if(attempt===2)throw error(/^[a-z_]+$/.test(e.code||'')?e.code:'download_interrupted_retry');}
  }
  throw error('download_checksum_mismatch');
}
export async function vendorBinary(name,directory,{platform=process.platform,progress}={}){
  const vendor=vendors[name]?.[platform];if(!vendor)throw error('unsupported_vendor_platform');
  privateDir(directory);const binary=path.join(directory,name+(platform==='win32'?'.exe':'')),receipt=binary+'.json';
  if(fs.existsSync(binary)&&fs.existsSync(receipt)){const r=read(receipt);if(r.source===vendor.sha256&&r.binary===await hash(binary))return binary;}
  const archive=path.join(directory,name+'.download');await downloadVerified(vendor.url,archive,vendor.sha256,{progress});
  const staged=binary+'.'+crypto.randomBytes(6).toString('hex')+'.new';
  if(vendor.format==='gzip')await pipeline(fs.createReadStream(archive),createGunzip(),fs.createWriteStream(staged,{mode:0o700}));
  else if(vendor.format==='zip'){
    const dir=privateDir(path.join(directory,'unpack-'+crypto.randomBytes(6).toString('hex'))),zip=archive+'.zip';fs.copyFileSync(archive,zip);
    const ps="param([string]$Archive,[string]$Out) $ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $Archive -DestinationPath $Out";
    const script=path.join(dir,'extract.ps1');fs.writeFileSync(script,'\ufeff'+ps);
    const r=await run('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-Archive',zip,'-Out',dir],{timeout:60000});
    if(r.code!==0)throw error('vendor_extract_failed');
    const files=fs.readdirSync(dir,{recursive:true}).filter(n=>/^mihomo[^/\\]*\.exe$/.test(n));if(files.length!==1)throw error('vendor_binary_missing');
    fs.copyFileSync(path.join(dir,files[0]),staged);fs.rmSync(dir,{recursive:true});fs.rmSync(zip);
  }else fs.copyFileSync(archive,staged);
  fs.chmodSync(staged,0o700);fs.renameSync(staged,binary);writePrivate(receipt,{source:vendor.sha256,binary:await hash(binary)});fs.rmSync(archive);return binary;
}
