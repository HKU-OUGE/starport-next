import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {spawnSync} from 'node:child_process';
import {VERSION,validatePlan as nativeValidatePlan,publicPlan} from '../packages/installer/plan.mjs';import {createInstaller as nativeCreateInstaller} from '../packages/installer/installation.mjs';import {payload,acquireLock,claim} from '../packages/installer/owned-files.mjs';import {serveInstaller} from '../packages/installer/server.mjs';import {parseSubscription} from '../packages/installer/subscription.mjs';
const installerPlatform=process.platform==='win32'?'win32':'linux';
const validatePlan=value=>nativeValidatePlan(value,installerPlatform),createInstaller=options=>nativeCreateInstaller({...options,platform:installerPlatform});
const core={features:{workspace:false,clients:false,inputMethod:false}};
function fixture(t){const dir=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-setup-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const source=path.join(dir,'source'),root=path.join(dir,'installed'),runtime=process.platform==='win32'?'runtime/node.exe':'runtime/bin/node',files=[];
 for(const [name,content]of [['app/packages/installer/cli.mjs','// fixture'],[runtime,'fixture runtime'],['app/package.json','{}']]){const f=path.join(source,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,content);files.push({path:name,sha256:crypto.createHash('sha256').update(content).digest('hex'),executable:false});}
 fs.writeFileSync(path.join(source,'payload-manifest.json'),JSON.stringify({format:'starport-release',version:VERSION,platform:installerPlatform,arch:'x64',files}));return {source,root};}
const fake=()=>({ensureIdle:async()=>{},stopOwned:async()=>{},runStage:async()=>{},uninstallRuntime:async()=>{}});
test('installer requires explicit basic-store choice and validates feature dependencies',()=>{
 assert.throws(()=>nativeValidatePlan(core,'darwin'),/platform_not_supported/);assert.equal(validatePlan(core).credentialStorage,'keyring');assert.throws(()=>validatePlan({...core,credentialStorage:'basic'}),/explicit_choice/);
 assert.equal(validatePlan({...core,credentialStorage:'basic',basicAcknowledged:true}).credentialStorage,'basic');
 assert.throws(()=>validatePlan({features:{workspace:false}}),/workspace_required/);assert.throws(()=>validatePlan({...core,features:{...core.features,api:true}}),/api_requires/);
 const p=publicPlan({apiKey:'private-example',compute:{privateKey:'private-key',token:'private-token',knownHosts:'known'},remote:{token:'private-tunnel'}});assert.ok(!JSON.stringify(p).includes('private-'));
});
test('release payload rejects modified bytes before the installation directory is claimed',async t=>{
 const {root,source}=fixture(t);await payload(source,installerPlatform);fs.appendFileSync(path.join(source,'app/package.json'),'changed');const m=createInstaller({root,source,driver:fake()});await assert.rejects(m.apply(core),/release_integrity_failed/);assert.equal(fs.existsSync(root),false);assert.equal(m.snapshot().running,false);
});
test('install, repair and uninstall preserve project data unless deletion is explicitly chosen',async t=>{
 const {root,source}=fixture(t),m=createInstaller({root,source,driver:fake()});await m.apply(core);assert.equal(m.snapshot().installed,true);
 const data=path.join(root,'private/project.txt');fs.writeFileSync(data,'owned example project');await m.apply(core);assert.equal(fs.readFileSync(data,'utf8'),'owned example project');
 const id=m.snapshot().installationId;await assert.rejects(m.uninstall({deleteData:'false',confirmId:id}),/explicit_data/);await assert.rejects(m.uninstall({confirmId:'other'}),/confirmation/);
 await m.uninstall({confirmId:id});assert.equal(fs.existsSync(path.join(root,'app')),false);assert.equal(fs.readFileSync(data,'utf8'),'owned example project');
 const restored=createInstaller({root,source,driver:fake()});await restored.apply(core);assert.equal(fs.readFileSync(data,'utf8'),'owned example project');await restored.uninstall({deleteData:true,confirmId:id});assert.equal(fs.existsSync(path.join(root,'private')),false);
});
test('cancelled system authorization is resumable, not reported as success',async t=>{
 const {root,source}=fixture(t);let denied=true;const d=fake();d.runStage=async s=>{if(s==='prerequisites'&&denied)throw Object.assign(Error('cancelled'),{code:'administrator_authorization_cancelled'});};const m=createInstaller({root,source,driver:d});await assert.rejects(m.apply(core),/authorization_cancelled/);assert.equal(m.snapshot().installed,false);assert.equal(m.snapshot().progress.phase,'failed');denied=false;await m.apply(core);assert.equal(m.snapshot().installed,true);
});
test('active work prevents repair and removal without changing the installed files',async t=>{
 const {root,source}=fixture(t),d=fake(),m=createInstaller({root,source,driver:d});await m.apply(core);const before=fs.readFileSync(path.join(root,'installation.json'),'utf8');d.ensureIdle=async()=>{throw Object.assign(Error('busy'),{code:'active_work_close_before_update'});};await assert.rejects(m.apply(core),/active_work/);assert.equal(fs.readFileSync(path.join(root,'installation.json'),'utf8'),before);await assert.rejects(m.uninstall({confirmId:m.snapshot().installationId}),{code:'active_work_close_before_update'});assert.equal(fs.existsSync(path.join(root,'app/package.json')),true);
});
test('installation lock excludes other managers and forged data-root symlinks',{skip:process.platform==='win32'},async t=>{
 const {root,source}=fixture(t),m=createInstaller({root,source,driver:fake()});await m.apply(core);const id=m.snapshot().installationId,release=acquireLock(root,id);await assert.rejects(m.uninstall({confirmId:id}),/installation_busy/);release();fs.renameSync(path.join(root,'private'),path.join(root,'kept'));fs.symlinkSync('kept',path.join(root,'private'));await assert.rejects(m.uninstall({confirmId:id}),/layout_symlink/);assert.equal(fs.existsSync(path.join(root,'kept/setup/options.json')),true);
});
test('installer HTTP rejects missing login, cross-origin writes and ambient forwarding headers',async t=>{
 const {root,source}=fixture(t),manager=createInstaller({root,source,driver:fake()}),s=await serveInstaller(manager);t.after(()=>s.close());
 assert.equal((await fetch(s.origin+'/api/state')).status,400);const token=s.launchUrl.split('#')[1];
 assert.equal((await fetch(s.origin+'/api/login',{method:'POST',headers:{origin:'https://example.com'},body:JSON.stringify({token})})).status,400);
 const r=await fetch(s.origin+'/api/login',{method:'POST',headers:{origin:s.origin},body:JSON.stringify({token})});const cookie=r.headers.get('set-cookie').split(';')[0];
 const status=await(await fetch(s.origin+'/api/state',{headers:{cookie}})).json();assert.equal(JSON.stringify(status).includes(token),false);
 const write=await fetch(s.origin+'/api/apply',{method:'POST',headers:{origin:s.origin,cookie},body:JSON.stringify(core)});assert.equal(write.status,400);assert.equal(fs.existsSync(root),false);
 assert.equal((await fetch(s.origin+'/api/state',{headers:{cookie,'x-forwarded-for':'example'}})).status,400);
});
test('Clash subscription parser selects supported verified transports without treating YAML as code',()=>{
 const s=parseSubscription('proxies:\n - {name: example, type: trojan, server: proxy.example.com, port: 443, password: example}\n - {name: rejected, type: trojan, skip-cert-verify: true}');assert.equal(s.nodes.length,1);assert.throws(()=>parseSubscription('!!js/function function(){}'),/invalid_subscription/);
});
test('new-project basic storage does not migrate existing keyrings or later downgrade a protected project',{skip:process.platform!=='linux'},()=>{
 const r=spawnSync('python3',['-I','-B','-c',String.raw`
import importlib.util,tempfile,pathlib
s=importlib.util.spec_from_file_location('storage','packages/wsl/credential-store.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d);assert m.select_store(p/'fresh','basic')=='basic'
 assert m.select_store(p/'protected','keyring')=='keyring'
 assert m.select_store(p/'protected','basic')=='keyring'
 (p/'legacy/.local/share/keyrings').mkdir(parents=True)
 assert m.select_store(p/'legacy','basic')=='keyring'
`],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});
test('verified downloads resume the existing partial file and reject corrupt bytes',async t=>{
 const {source}=fixture(t),file=path.join(source,'download'),content=Buffer.from('complete release artifact'),digest=crypto.createHash('sha256').update(content).digest('hex');fs.writeFileSync(file+'.partial',content.subarray(0,8));const {downloadVerified}=await import('../packages/installer/download.mjs');let ranges=[];
 await downloadVerified('https://example.com/asset',file,digest,{fetcher:async(_url,o)=>{ranges.push(o.headers.Range);return new Response(content.subarray(8),{status:206,headers:{'content-range':'bytes 8-24/25','content-length':content.length-8}});}});assert.deepEqual(fs.readFileSync(file),content);assert.deepEqual(ranges,['bytes=8-']);
 await assert.rejects(downloadVerified('https://example.com/asset',file+'-bad',digest,{fetcher:async()=>new Response('corrupt')}),/checksum/);assert.equal(fs.existsSync(file+'-bad'),false);
});

test('Windows installer registers and removes owned menus under a Unicode path',{skip:process.platform!=='win32'},t=>{
 const {root}=fixture(t);claim(root);fs.mkdirSync(path.join(root,'runtime'),{recursive:true});fs.copyFileSync(process.execPath,path.join(root,'runtime/node.exe'));
 fs.mkdirSync(path.join(root,'app/packages/installer'),{recursive:true});fs.writeFileSync(path.join(root,'app/packages/installer/cli.mjs'),'// fixture');
 for(const action of ['register','register','remove']){
  const r=spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('packages/installer/integration.ps1'),'-Root',root,'-Action',action],{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.stdout+r.stderr);
 }
});
