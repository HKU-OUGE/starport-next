import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {runtimeChoice,createWorkspaceRuntime} from '../packages/control/workspace-runtime.mjs';
import {createLinuxServices,linuxServicePlan,unitArgument} from '../packages/control/linux-services.mjs';
import {linuxShortcuts,desktopArgument} from '../packages/linux/shortcuts.mjs';
import {folderUser,mountArguments,mountedFilesystem} from '../packages/control/linux-folders.mjs';
import {loadControlOptions} from '../packages/control/config.mjs';
const temporary=t=>{const d=fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()),'starport-linux-'));t.after(()=>fs.rmSync(d,{force:true,recursive:true}));return d;};

test('host selection preserves WSL2 and makes Linux projects fail closed until QEMU is installed',async t=>{
  assert.equal(runtimeChoice({},'linux'),'qemu');assert.equal(runtimeChoice({},'win32'),'wsl2');
  assert.throws(()=>runtimeChoice({runtimeKind:'wsl2'},'linux'),/wsl_runtime_requires_windows/);
  const state=temporary(t),runtime=await createWorkspaceRuntime(state,{runtimeKind:'qemu'},{destinations:{},capabilities:()=>({})});
  assert.equal(runtime.status().kind,'qemu');assert.equal(runtime.status().installed,false);
  assert.throws(()=>runtime.execute('main',{operation:'exec'}),/qemu_project_install_required/);runtime.close();
});
test('Linux configuration uses relative VM state and an explicit seamless opt-in',t=>{
  const d=temporary(t),file=path.join(d,'host.json');
  fs.writeFileSync(file,JSON.stringify({format:'starport-host-control',version:1,runtime:{kind:'qemu',state:'projects'},seamless:true}));
  const c=loadControlOptions(file);assert.equal(c.qemuState,path.join(d,'projects'));assert.equal(c.seamless,true);
  fs.writeFileSync(file,JSON.stringify({format:'starport-host-control',version:1,runtime:{kind:'qemu',state:'../host'}}));
  assert.throws(()=>loadControlOptions(file),/relative_control_path_required/);
});
test('systemd registration is owned, escaped, disabled without killing tasks, and never starts duplicates', {skip:process.platform!=='linux'},async t=>{
  const dir=temporary(t),state=path.join(dir,'state'),config=path.join(dir,'host.json'),units=path.join(dir,'units'),calls=[];
  fs.writeFileSync(config,JSON.stringify({format:'starport-host-control',version:1,runtime:{kind:'qemu',state:'vm'}}));
  const manager=createLinuxServices(state,config,{unitDirectory:units,repo:dir,execute:async(_file,args)=>{calls.push(args);return {code:0,stdout:args.includes('--value')?'inactive\n':'ActiveState=inactive\nUnitFileState=enabled\nMainPID=0\n'};}});
  const plan=linuxServicePlan(state,config);assert.deepEqual(plan.units.map(v=>v.id),['vm','control']);
  assert.match(plan.units.at(-1).text,/After=starport-next-.*-vm.service/);assert.match(plan.units[0].text,/KillMode=mixed/);
  assert.equal(unitArgument('a% b$"c'),'"a%% b$$\\"c"');assert.throws(()=>unitArgument('x\ny'));
  await manager.action('enable');assert.equal(calls.some(a=>a.includes('start')),false);
  fs.writeFileSync(path.join(state,'control.lock'),JSON.stringify({pid:process.pid}));
  if(!process.env.INVOCATION_ID)await assert.rejects(manager.action('start'),/stop_manual_control_before_service_start/);
  await manager.action('disable');assert.equal(calls.some(a=>a.includes('stop')),false);
  fs.unlinkSync(path.join(state,'control.lock'));await manager.action('unregister');assert.equal(fs.readdirSync(units).length,0);
  await manager.action('enable');fs.appendFileSync(path.join(units,manager.plan().units[0].name),'# edited\n');
  await assert.rejects(manager.action('unregister'),/service_file_changed/);
});
test('desktop entries are fixed project actions and refuse to remove edited or foreign files',{skip:process.platform!=='linux'},t=>{
  const dir=temporary(t),state=path.join(dir,'state'),directory=path.join(dir,'apps');
  const a=linuxShortcuts(state,{directory,repository:dir});assert.equal(a.count,2);
  assert.equal(fs.readFileSync(path.join(directory,fs.readdirSync(directory).find(v=>v.endsWith('panel.desktop'))),'utf8').includes('Terminal=false'),true);
  linuxShortcuts(state,{directory,remove:true});assert.equal(fs.readdirSync(directory).length,0);
  assert.equal(linuxShortcuts(state,{directory,seamless:true}).count,5);
  const f=path.join(directory,fs.readdirSync(directory)[0]);fs.appendFileSync(f,'# changed');assert.throws(()=>linuxShortcuts(state,{directory,remove:true}),/shortcut_changed/);
  assert.throws(()=>desktopArgument('a\nb'));assert.ok(desktopArgument('%f').includes('%%f'));
});
test('project file manager endpoint cannot request a shell, host mount or arbitrary user',()=>{
  assert.notEqual(folderUser('main'),folderUser('other'));assert.throws(()=>folderUser('../host'));
  const argv=mountArguments('/private/vm',2222,folderUser('main'),'/private/mount');
  assert.equal(argv[0],folderUser('main')+'@127.0.0.1:/project');
  assert.ok(argv.includes('StrictHostKeyChecking=yes'));assert.ok(argv.includes('IdentityAgent=none'));assert.ok(argv.includes('nodev,nosuid,noexec'));
  assert.throws(()=>mountArguments('/private/vm',2222,'root','/mnt'));
  assert.equal(mountedFilesystem('/private/mount','1 2 0:1 / /private/mount rw - fuse.sshfs project rw'),'fuse.sshfs');
});

test('generated units parse with the real systemd user manager',{skip:process.platform!=='linux'||!process.env.XDG_RUNTIME_DIR},t=>{
  const dir=temporary(t),config=path.join(dir,'host.json');
  fs.writeFileSync(config,JSON.stringify({format:'starport-host-control',version:1,runtime:{kind:'qemu',state:'vm'}}));
  const plan=linuxServicePlan(path.join(dir,'state'),config),paths=plan.units.map(u=>{const p=path.join(dir,u.name);fs.writeFileSync(p,u.text);return p;});
  const r=spawnSync('systemd-analyze',['--user','verify',...paths],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
});

test('native display connections serialize startup and stop only their own viewer',{skip:process.platform!=='linux'},async t=>{
  const {createSeamless}=await import('../packages/control/seamless.mjs');
  const {EventEmitter}=await import('node:events');const {PassThrough}=await import('node:stream');const net=await import('node:net');
  const dir=temporary(t),children=[],peers=[];let attached=0;
  const runtime={status:()=>({seamless:true}),attachViewer:(_id,stream)=>{attached++;stream.on('error',()=>{});}};
  const launcher=(_file,args)=>{const child=new EventEmitter();child.exitCode=null;child.stdout=new PassThrough();children.push(child);
    child.kill=()=>{if(child.exitCode===null){child.exitCode=0;queueMicrotask(()=>{child.emit('exit',0);child.emit('close',0);});}return true;};
    const socket=args.at(-1);setTimeout(()=>{const peer=net.connect(socket,()=>setTimeout(()=>child.stdout.write('STARPORT_VIEWER_READY\n'),25));peer.on('error',()=>{});peers.push(peer);},10);return child;};
  const service=createSeamless(dir,runtime,{launch:launcher,available:()=>true});t.after(()=>{service.close();for(const peer of peers)peer.destroy();});
  const [first,second]=await Promise.all([service.connect('main'),service.connect('main')]);
  assert.equal(first.phase,'running');assert.equal(second.phase,'running');assert.equal(children.length,1);assert.equal(attached,1);
  await service.disconnect('main');assert.equal(children[0].exitCode,0);
  await service.connect('main');assert.equal(children.length,2);assert.equal(attached,2);await service.disconnect('main');
});
