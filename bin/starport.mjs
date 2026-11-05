#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { ConfigError, fail, validateConfig } from '../packages/config/model.mjs';
import { decodeBundle, preview } from '../packages/config/portable.mjs';
import { createProfile, exportProfile, importProfile, loadProfile, readJson, writeExport } from '../packages/config/store.mjs';
import { plan } from '../packages/planner/index.mjs';
import { doctor,prepare } from '../packages/runtime/qemu.mjs';
import { start,control,execute,verify } from '../packages/runtime/control.mjs';
import { bootstrap,chat,fileOperation,putFile,getFile } from '../packages/runtime/agent.mjs';
import { DEFAULT_HOSTS } from '../packages/runtime/egress.mjs';
import { NATIVE_HOSTS,installNative,nativeStatus,nativeUi,launchNative } from '../packages/runtime/native.mjs';
import { startHostControl } from '../packages/control/server.mjs';
import { loadControlOptions } from '../packages/control/config.mjs';
import { installWsl,updateWslRuntime } from '../packages/wsl/runtime.mjs';
import { installWslClients,configureWslClients } from '../packages/wsl/clients.mjs';
import {installLinuxProject} from '../packages/linux/install.mjs';
import {linuxShortcuts} from '../packages/linux/shortcuts.mjs';
import {createLinuxServices} from '../packages/control/linux-services.mjs';
import { privateDir } from '../packages/runtime/common.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const help = `Starport Next — 配置与部署规划工具

  starport init --preset desktop-dsw --out profiles/work
  starport validate --config examples/desktop-dsw.json
  starport plan --profile profiles/work
  starport config preview --file backup.spx
  starport config import --file backup.spx --out profiles/imported
  starport config export --profile profiles/work --out config.json
  starport config export --profile profiles/work --out backup.spx --include-secrets

  starport local doctor
  starport local prepare --state private/workspace
  starport local start --state private/workspace --profile profiles/work
  starport local verify --state private/workspace
  starport local bootstrap --state private/workspace
  starport local exec --state private/workspace --script example.sh
  starport local chat --state private/workspace --prompt-file prompt.txt
  starport local files --state private/workspace --operation list
  starport local start --state private/workspace --profile profiles/work --client native
  starport local native-install --state private/workspace
  starport local native-ui --state private/workspace
  starport local native-login --state private/workspace
  starport local native-desktop --state private/workspace
  starport local native-status --state private/workspace
  starport local stop --state private/workspace

  starport control serve --state private/control --config private/host-control.json
  starport control init --out private/host-control.json
  starport linux install --config private/host-control.json
  starport linux update-runtime --config private/host-control.json
  starport linux services enable --state private/control --config private/host-control.json
  starport linux shortcuts register --state private/control --seamless
  starport wsl install --state private/wsl --rootfs ubuntu.tar.gz --sha256 SHA256
  starport linux ime-install --config private/host-control.json
  starport wsl ime-install --state private/wsl --config private/host-control.json
  starport wsl clients-install --state private/wsl --config private/host-control.json
  starport wsl clients-configure --state private/wsl
  starport wsl remote-display-install --state private/wsl --config private/host-control.json
  starport wsl update-runtime --state private/wsl

加密操作默认隐藏输入口令；自动化可传 --password-file，口令不会进入命令参数。
预设：desktop-dsw、single-machine、server-hosted。
配置命令保持离线；local 命令操作独立 QEMU 工作区，不修改现有服务器。`;
function argumentsFor(args, accepted) {
  const out = {};
  while (args.length) {
    const name = args.shift();
    if (!accepted.includes(name) || Object.hasOwn(out, name)) fail('unknown_or_duplicate_option');
    if (['--include-secrets','--ephemeral','--replace','--seamless'].includes(name)) out[name] = true;
    else {
      const value = args.shift();
      if (!value || value.startsWith('--')) fail('option_value_required');
      out[name] = value;
    }
  }
  return out;
}
const required = (a, k) => a[k] || fail('required_option_' + k.replaceAll('-', ''));
async function password(a) {
  if (a['--password-file']) {
    const file = a['--password-file']; const st = fs.lstatSync(file);
    if (!st.isFile() || st.isSymbolicLink() || st.size > 4096) fail('invalid_password_file');
    if (process.platform !== 'win32' && st.mode & 0o077) fail('password_file_must_be_private');
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail('password_file_required_without_terminal');
  return new Promise((resolve, reject) => {
    let value = '';
    const wasRaw = process.stdin.isRaw;
    readline.emitKeypressEvents(process.stdin); process.stdin.setRawMode(true); process.stdin.resume();
    process.stderr.write('配置包口令（至少 12 个字符，不回显）：');
    const done = (error) => {
      process.stdin.removeListener('keypress', onKey); process.stdin.setRawMode(Boolean(wasRaw)); process.stdin.pause();
      process.stderr.write('\n'); error ? reject(error) : resolve(value);
    };
    const onKey = (text, key = {}) => {
      if (key.ctrl && key.name === 'c') return done(new ConfigError('cancelled'));
      if (key.name === 'return' || key.name === 'enter') return done();
      if (key.name === 'backspace') value = [...value].slice(0, -1).join('');
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text)) value += text;
      if (value.length > 1024) done(new ConfigError('password_too_long'));
    };
    process.stdin.on('keypress', onKey);
  });
}
const show = value => process.stdout.write(JSON.stringify(value, null, 2) + '\n');

async function main() {
  const args = process.argv.slice(2); const command = args.shift();
  if (!command || ['help','--help','-h'].includes(command)) return console.log(help);
  if(command==='control'){
    const action=args.shift();
    if(action==='init'){
      const a=argumentsFor(args,['--out']),file=path.resolve(required(a,'--out'));privateDir(path.dirname(file));
      fs.writeFileSync(file,JSON.stringify({format:'starport-host-control',version:1,port:18884,...(process.platform==='win32'?{wslState:'wsl'}:{runtime:{kind:'qemu',state:'qemu'},seamless:false})},null,2)+'\n',{flag:'wx',mode:0o600});
      return show({created:true,egress:'closed',servers:'unconfigured'});
    }
    if(action!=='serve')fail('unknown_control_command');
    const a=argumentsFor(args,['--state','--config','--profile','--password-file','--client']);
    const options=loadControlOptions(required(a,'--config'));
    if(a['--profile']){
      const loaded=await loadProfile(a['--profile'],await password(a),{unlock:true});
      const provider=loaded.privateValues[loaded.config.engine.providerRef];
      if(provider){if(provider.endpoint!=='https://api.anthropic.com')fail('official_api_provider_required');options.apiKey=provider.token;options.model=loaded.config.engine.model;}
      const selected=loaded.privateValues[loaded.config.network.selectionRef];
      if(selected)options.proxyCandidates=selected.candidates.map(c=>{const sub=loaded.privateValues[c.subscriptionRef];if(!sub?.nodes[c.nodeIndex])fail('cached_proxy_node_required');return {node:sub.nodes[c.nodeIndex],hosts:sub.hosts||{}};});
    }
    if(a['--client']&&!['api','native'].includes(a['--client']))fail('invalid_client_mode');
    if(a['--client']==='native')delete options.apiKey;
    const service=await startHostControl(required(a,'--state'),options);
    show({url:service.url,phase:service.phase,platform:service.platform});
    let stopping=false;const stop=async()=>{if(stopping)return;stopping=true;await service.close();};
    process.on('SIGINT',stop);process.on('SIGTERM',stop);return;
  }
  if(command==='linux'){
    if(process.platform!=='linux')fail('linux_host_required');
    const action=args.shift();
    if(['install','clients-install','ime-install','update-runtime'].includes(action)){
      const a=argumentsFor(args,['--config','--cpus','--memory-mib','--disk-gib']);
      return show(await installLinuxProject(loadControlOptions(required(a,'--config')),{update:action==='update-runtime',repairClients:['clients-install','ime-install'].includes(action),imeOnly:action==='ime-install',onProgress:show,
        cpus:Number(a['--cpus']||2),memoryMiB:Number(a['--memory-mib']||4096),diskGiB:Number(a['--disk-gib']||16)}));
    }
    if(action==='services'){
      const operation=args.shift(),a=argumentsFor(args,['--state','--config']);
      const services=createLinuxServices(required(a,'--state'),required(a,'--config'));
      return show(operation==='plan'?services.plan():operation==='status'?await services.status():await services.action(operation));
    }
    if(action==='shortcuts'){
      const operation=args.shift(),a=argumentsFor(args,['--state','--workspace','--seamless']);
      if(!['register','remove'].includes(operation))fail('invalid_shortcut_action');
      return show(linuxShortcuts(required(a,'--state'),{workspace:a['--workspace']||'main',seamless:Boolean(a['--seamless']),remove:operation==='remove'}));
    }
    fail('unknown_linux_command');
  }
  if(command==='wsl'){
    const action=args.shift();
    if(action==='clients-configure'){
      const a=argumentsFor(args,['--state']);return show(await configureWslClients(required(a,'--state')));
    }
    if(action==='clients-install'||action==='remote-display-install'||action==='ime-install'){
      const a=argumentsFor(args,['--state','--config']);
      return show(await installWslClients(required(a,'--state'),loadControlOptions(required(a,'--config')),{onProgress:show,remoteOnly:action==='remote-display-install',imeOnly:action==='ime-install'}));
    }
    if(action==='update-runtime'){
      const a=argumentsFor(args,['--state']);return show(await updateWslRuntime(required(a,'--state')));
    }
    if(action!=='install')fail('unknown_wsl_command');
    const a=argumentsFor(args,['--state','--rootfs','--sha256']);
    return show(await installWsl(required(a,'--state'),{rootfs:required(a,'--rootfs'),sha256:required(a,'--sha256'),onProgress:show}));
  }
  if (command === 'local') {
    const action=args.shift();
    const a=argumentsFor(args,['--state','--cpus','--memory-mib','--disk-gib','--ephemeral','--installer-proxy','--upstream','--upstream-socket',
      '--profile','--password-file','--api-key-file','--model','--nodes-file','--proxy-binary','--script','--prompt-file','--resume','--effort',
      '--operation','--path','--source','--out','--destination','--replace','--offset','--allow-hosts','--client']);
    if(action==='doctor'){const result=doctor();show(result);if(!result.ready)process.exitCode=2;return;}
    const state=path.resolve(required(a,'--state'));
    if(action==='prepare')return show(await prepare(state,{cpus:Number(a['--cpus']||2),memoryMiB:Number(a['--memory-mib']||2048),diskGiB:Number(a['--disk-gib']||8),
      ephemeral:Boolean(a['--ephemeral']),installerProxy:a['--installer-proxy']?{kind:'http',url:a['--installer-proxy']}:undefined,
      onProgress:show}));
    if(action==='start'){
      const settings={};
      if(a['--client']&&!['api','native'].includes(a['--client']))fail('invalid_client_mode');
      const native=a['--client']==='native';
      if(native&&a['--api-key-file'])fail('native_account_mode_does_not_accept_api_key');
      if(a['--profile']){
        const loaded=await loadProfile(a['--profile'],await password(a),{unlock:true});
        const provider=loaded.privateValues[loaded.config.engine.providerRef];
        if(!native&&provider&&provider.endpoint!=='https://api.anthropic.com')fail('local_runtime_requires_official_api_provider');
        if(!native){settings.apiKey=provider?.token;settings.model=loaded.config.engine.model;}
        const selection=loaded.privateValues[loaded.config.network.selectionRef];
        if(selection)settings.proxyCandidates=selection.candidates.map(c=>{
          const sub=loaded.privateValues[c.subscriptionRef];if(!sub?.nodes[c.nodeIndex])fail('cached_proxy_node_required');
          return {node:sub.nodes[c.nodeIndex],hosts:sub.hosts||{}};
        });
      }
      if(a['--nodes-file']){
        const sub=readJson(a['--nodes-file']);settings.proxyCandidates=sub.nodes.slice(0,8).map(node=>({node,hosts:sub.hosts||{}}));
      }
      if(a['--api-key-file']){
        const st=fs.lstatSync(a['--api-key-file']);if(!st.isFile()||st.isSymbolicLink()||st.size>65536)fail('invalid_api_key_file');
        const text=fs.readFileSync(a['--api-key-file'],'utf8'),matches=[...new Set(text.match(/sk-ant-[A-Za-z0-9_-]+/g)||[])];
        if(matches.length!==1||matches[0].startsWith('sk-ant-oat'))fail('single_api_key_required');settings.apiKey=matches[0];
      }
      if(a['--model'])settings.model=a['--model'];
      if(settings.apiKey&&(!settings.model||settings.model==='select-at-setup'))fail('select_model_first');
      if(a['--upstream']&&a['--upstream-socket'])fail('choose_one_upstream');
      if(a['--upstream'])settings.upstream={kind:'http',url:a['--upstream']};
      if(a['--upstream-socket'])settings.upstream={kind:'unix',path:a['--upstream-socket']};
      if(a['--proxy-binary'])settings.proxyBinary=a['--proxy-binary'];
      if(native||a['--allow-hosts'])settings.hosts=[...new Set([...DEFAULT_HOSTS,...(native?NATIVE_HOSTS:[]),...(a['--allow-hosts']||'').split(',').map(x=>x.trim().toLowerCase()).filter(Boolean)])];
      if(!settings.upstream&&!settings.proxyCandidates)fail('controlled_proxy_required');
      return show(await start(state,settings));
    }
    if(action==='native-install')return show(await installNative(state,{onData:text=>process.stdout.write(text)}));
    if(action==='native-status')return show(await nativeStatus(state));
    if(action==='native-ui')return show(await nativeUi(state));
    if(['native-login','native-desktop','native-terminal','native-browser'].includes(action))return show(await launchNative(state,action.slice(7)));
    if(action==='status')return show(await control(state));
    if(action==='stop')return show(await control(state,'/stop','POST'));
    if(action==='verify')return show(await verify(state));
    if(action==='bootstrap')return show(await bootstrap(state,{onData:text=>process.stdout.write(text)}));
    if(action==='exec'){
      const r=await execute(state,fs.readFileSync(required(a,'--script'),'utf8'),{timeout:900000,onData:text=>process.stdout.write(text)});
      if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.code||0;return;
    }
    if(action==='chat'){
      const r=await chat(state,fs.readFileSync(required(a,'--prompt-file'),'utf8'),{resume:a['--resume'],effort:a['--effort']||'low',onData:text=>process.stdout.write(text)});
      if(r.stderr)process.stderr.write(r.stderr);process.exitCode=r.code||0;return;
    }
    if(action==='files'){
      if(a['--operation']==='upload')return show(await putFile(state,required(a,'--source'),required(a,'--path'),{replace:Boolean(a['--replace'])}));
      if(a['--operation']==='download')return show(await getFile(state,required(a,'--path'),required(a,'--out')));
      return show(await fileOperation(state,{operation:required(a,'--operation'),path:a['--path']||'',destination:a['--destination'],offset:Number(a['--offset']||0)}));
    }
    fail('unsupported_local_action');
  }
  if (command === 'init') {
    const a = argumentsFor(args, ['--preset','--out']); const preset = a['--preset'] || 'desktop-dsw';
    if (!['desktop-dsw','single-machine','server-hosted'].includes(preset)) fail('invalid_preset');
    return show(createProfile(required(a, '--out'), readJson(path.join(root, 'examples', preset + '.json'))));
  }
  if (command === 'validate' || command === 'plan') {
    const a = argumentsFor(args, ['--config','--profile']);
    if (Boolean(a['--config']) === Boolean(a['--profile'])) fail('choose_config_or_profile');
    const config = a['--config'] ? validateConfig(readJson(a['--config'])) : (await loadProfile(a['--profile'])).config;
    return show(command === 'plan' ? plan(config) : { valid: true, verified: false, version: config.version });
  }
  if (command === 'config') {
    const action = args.shift();
    const a = argumentsFor(args, ['--file','--profile','--out','--password-file','--include-secrets']);
    if (action === 'export') {
      const includeSecrets = Boolean(a['--include-secrets']);
      const value = await exportProfile(required(a, '--profile'), includeSecrets ? await password(a) : undefined, { includeSecrets });
      writeExport(required(a, '--out'), value); return show({ exported: true, encrypted: includeSecrets, includesSecrets: includeSecrets });
    }
    if (!['preview','import'].includes(action)) fail('unsupported_config_action');
    const value = readJson(required(a, '--file'));
    // Legacy plaintext profiles with connection identities are re-encrypted on import.
    const needsPassword = value.format?.endsWith('-encrypted') || (action === 'import' && value.format === 'starport-pi-profile');
    const pass = needsPassword ? await password(a) : undefined;
    if (action === 'preview') return show(preview(await decodeBundle(value, pass)));
    return show(await importProfile(required(a, '--out'), value, pass));
  }
  fail('command_not_implemented');
}
try { await main(); }
catch (e) {
  const code = e instanceof ConfigError ? e.code : e.code === 'ENOENT' ? 'file_not_found' : /^[a-z][a-z_]+$/.test(e.code||'') ? e.code : 'operation_failed';
  process.stderr.write(JSON.stringify({ ok: false, error: code }) + '\n'); process.exitCode = 1;
}
