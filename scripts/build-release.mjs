#!/usr/bin/env node
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import {fileURLToPath} from 'node:url';import {spawnSync} from 'node:child_process';
import {downloadVerified} from '../packages/installer/download.mjs';import {VERSION} from '../packages/installer/plan.mjs';import {hash} from '../packages/runtime/common.mjs';
const repo=fileURLToPath(new URL('../',import.meta.url)),argv=process.argv.slice(2),o={};while(argv.length){const k=argv.shift();if(!['--platform','--out','--makensis'].includes(k)||!argv.length)throw Error('invalid_build_arguments');o[k]=argv.shift();}
const platform=o['--platform']||process.platform;if(!['linux','win32'].includes(platform)||process.arch!=='x64')throw Error('unsupported_build_target');
const out=path.resolve(o['--out']||path.join(repo,'dist')),work=fs.mkdtempSync(path.join(os.tmpdir(),'starport-release-'));fs.mkdirSync(out,{recursive:true});const source=path.join(work,'source');fs.mkdirSync(source);
function command(file,args,cwd=work){const r=spawnSync(file,args,{cwd,stdio:'inherit',shell:false,env:process.env});if(r.status!==0)throw Error('release_build_command_failed');}
try{
 const version='22.23.1',name=`node-v${version}-${platform==='win32'?'win-x64.zip':'linux-x64.tar.gz'}`;
 const sums=await(await fetch(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`)).text();const line=sums.split('\n').find(l=>l.endsWith('  '+name));if(!line)throw Error('node_digest_missing');const digest=line.split(/\s+/)[0];
 const archive=path.join(work,name);await downloadVerified(`https://nodejs.org/dist/v${version}/${name}`,archive,digest);
 if(platform==='win32'){
  if(process.platform==='win32')command('powershell.exe',['-NoProfile','-Command',`Expand-Archive -LiteralPath '${archive.replaceAll("'","''")}' -DestinationPath '${work.replaceAll("'","''")}'`]);
  else command('unzip',['-q',archive,'-d',work]);
 }else command('tar',['-xzf',archive,'-C',work]);
 fs.renameSync(path.join(work,name.replace(/\.(zip|tar\.gz)$/,'')),path.join(source,'runtime'));
 const app=path.join(source,'app');fs.mkdirSync(app);
 const listed=spawnSync('git',['ls-files','-z'],{cwd:repo,encoding:'utf8'});if(listed.status!==0)throw Error('tracked_source_required');
 for(const name of listed.stdout.split('\0').filter(Boolean)){
  if(name.startsWith('.github/')||name.startsWith('packaging/'))continue;
  const src=path.join(repo,name);if(!fs.statSync(src).isFile()||fs.lstatSync(src).isSymbolicLink())throw Error('unsupported_source_file');const dest=path.join(app,name);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(src,dest);fs.chmodSync(dest,fs.statSync(src).mode&0o777);
 }
 const npm=process.platform==='win32'?path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'):path.resolve(path.dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js');
 const fallback='/usr/share/nodejs/npm/bin/npm-cli.js';command(process.execPath,[fs.existsSync(npm)?npm:fallback,'ci','--ignore-scripts','--no-audit','--no-fund','--os='+platform,'--cpu=x64'],app);
 fs.rmSync(path.join(app,'node_modules/.bin'),{recursive:true,force:true});
 function materialize(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const p=path.join(dir,entry.name);if(entry.isSymbolicLink()){const target=fs.realpathSync(p);if(!target.startsWith(path.join(source,'runtime')+path.sep)||!fs.statSync(target).isFile())throw Error('unsafe_runtime_link');const mode=fs.statSync(target).mode;fs.unlinkSync(p);fs.copyFileSync(target,p);fs.chmodSync(p,mode&0o777);}else if(entry.isDirectory())materialize(p);}}materialize(path.join(source,'runtime'));
 const files=[];async function walk(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const rel=prefix+entry.name,p=path.join(dir,entry.name);if(entry.isSymbolicLink())throw Error('release_symlink');if(entry.isDirectory())await walk(p,rel+'/');else files.push({path:rel,sha256:await hash(p),executable:!!(fs.statSync(p).mode&0o111)});}}
 await walk(source);fs.writeFileSync(path.join(source,'payload-manifest.json'),JSON.stringify({format:'starport-release',version:VERSION,platform,arch:'x64',files},null,2));
 if(platform==='linux'){
  const tar=path.join(work,'payload.tar.gz');command('tar',['-czf',tar,'-C',source,'.']);const sha=await hash(tar),header=fs.readFileSync(path.join(repo,'packaging/linux.run.in'),'utf8').replace('@PAYLOAD_SHA256@',sha),dest=path.join(out,`Starport-Next-${VERSION}-Linux-x64.run`);fs.writeFileSync(dest,header);fs.appendFileSync(dest,fs.readFileSync(tar));fs.chmodSync(dest,0o755);command('/bin/sh',[dest,'--check']);
 }else{
  const exe=path.join(out,`Starport-Next-${VERSION}-Windows-x64.exe`),binary=o['--makensis']||(process.platform==='win32'?'C:\\Program Files (x86)\\NSIS\\makensis.exe':'makensis'),prefix=process.platform==='win32'?'/':'-';
  command(binary,[prefix+'WX',prefix+'DPAYLOAD='+source,prefix+'DOUTPUT='+exe,path.join(repo,'packaging/windows.nsi')]);
 }
 const checks=await Promise.all(fs.readdirSync(out).filter(n=>/\.(exe|run)$/.test(n)).sort().map(async n=>(await hash(path.join(out,n)))+'  '+n));fs.writeFileSync(path.join(out,'SHA256SUMS.txt'),checks.join('\n')+'\n');console.log(JSON.stringify({version:VERSION,platform,output:out,verifiedSourceFiles:files.length}));
}finally{fs.rmSync(work,{recursive:true,force:true});}
