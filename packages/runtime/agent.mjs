import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { control,execute } from './control.mjs';
import { guest } from './qemu.mjs';
import { read,writePrivate,error } from './common.mjs';

const directory=fileURLToPath(new URL('./guest/',import.meta.url));
export function guestFiles(arch) {
  if(!['x64','arm64'].includes(arch))throw error('unsupported_guest_architecture');
  const files=Object.fromEntries(['package.json','package-lock.json','agent.mjs','files.py'].map(name=>[name,fs.readFileSync(path.join(directory,name),'utf8')]));
  const name='@anthropic-ai/claude-agent-sdk-linux-'+arch,pkg=JSON.parse(files['package.json']),lock=JSON.parse(files['package-lock.json']);
  pkg.dependencies[name]=pkg.dependencies['@anthropic-ai/claude-agent-sdk'];
  lock.packages[''].dependencies={...pkg.dependencies};
  delete lock.packages['node_modules/'+name].optional;
  files['package.json']=JSON.stringify(pkg,null,2)+'\n';files['package-lock.json']=JSON.stringify(lock,null,2)+'\n';
  return files;
}
export async function bootstrap(state,{onData}={}) {
  const lock=path.join(state,'bootstrap.lock');
  try{fs.writeFileSync(lock,String(process.pid),{flag:'wx',mode:0o600});}catch(e){if(e.code==='EEXIST')throw error('agent_bootstrap_already_in_progress');throw e;}
  try{return await installAgent(state,{onData});}finally{fs.rmSync(lock,{force:true});}
}
async function installAgent(state,{onData}={}) {
  const current=await control(state);if(!current.ready)throw error('workspace_not_ready');
  const files=guestFiles(read(path.join(state,'machine.json')).host.arch);
  const expected=crypto.createHash('sha256').update(files['package-lock.json']).digest('hex');
  const existing=await guest(state,current.sshPort,'test -f /opt/starport/agent/node_modules/.package-lock.json && sha256sum /opt/starport/agent/package-lock.json',{user:'control',timeout:15000});
  const reuse=existing.code===0&&existing.stdout.split(/\s/)[0]===expected;
  const upload=await guest(state,current.sshPort,"sudo python3 -c 'import json,pathlib,sys; d=pathlib.Path(\"/opt/starport/agent\"); d.mkdir(exist_ok=True); [(d/k).write_text(v) for k,v in json.load(sys.stdin).items()]'",{user:'control',input:JSON.stringify(files)});
  if(upload.code!==0)throw error('agent_bootstrap_upload_failed');
  const script=String.raw`set -eu
export PATH=/usr/local/bin:/usr/bin:/bin
export HOME=/root LANG=C.UTF-8 TZ=Asia/Taipei
export HTTP_PROXY=http://127.0.0.1:13128 HTTPS_PROXY=http://127.0.0.1:13128
export http_proxy=$HTTP_PROXY https_proxy=$HTTPS_PROXY
export NO_PROXY=127.0.0.1,localhost
cd /opt/starport
if [ ! -x node/bin/node ]; then
  case "$(uname -m)" in x86_64) arch=x64;; aarch64) arch=arm64;; *) exit 1;; esac
  name=node-v22.23.1-linux-$arch.tar.xz
  printf '%s\n' 'Downloading Node.js; existing bytes will be resumed.'
  downloaded=false
  for attempt in 1 2 3 4 5; do
    if curl --fail --silent --show-error --continue-at - --max-time 180 --proxy "$HTTPS_PROXY" "https://nodejs.org/dist/v22.23.1/$name" -o node.tar.xz; then downloaded=true; break; fi
    sleep 2
  done
  test "$downloaded" = true
  curl --fail --silent --show-error --retry 3 --max-time 60 --proxy "$HTTPS_PROXY" https://nodejs.org/dist/v22.23.1/SHASUMS256.txt -o node-sums.txt
  digest=$(awk -v name="$name" '$2==name {print $1}' node-sums.txt)
  test -n "$digest"
  printf '%s  node.tar.xz\n' "$digest" | sha256sum --check --status
  mkdir -p node
  tar -xJf node.tar.xz --strip-components=1 -C node
  rm node.tar.xz node-sums.txt
fi
ln -sf /opt/starport/node/bin/node /usr/local/bin/node
ln -sf /opt/starport/node/bin/npm /usr/local/bin/npm
cd /opt/starport/agent
printf '%s\n' 'Installing pinned Agent SDK packages.'
if [ "${reuse?'true':'false'}" != true ]; then
  npm ci --omit=optional --ignore-scripts --no-audit --no-fund --cache /tmp/starport-npm-cache
else
  printf '%s\n' 'Reusing the installed, matching dependency lock.'
fi
rm -rf /tmp/starport-npm-cache
chown -R root:root /opt/starport/agent /opt/starport/node
chmod -R go-w /opt/starport/agent /opt/starport/node
node --input-type=module -e 'import {query} from "@anthropic-ai/claude-agent-sdk"; console.log(JSON.stringify({sdkReady:typeof query==="function",node:process.version}))'
`;
  const result=await guest(state,current.sshPort,'sudo env -i PATH=/usr/local/bin:/usr/bin:/bin /bin/bash --noprofile --norc -s',{user:'control',input:script,timeout:900000,onData,maxBytes:4*1024*1024});
  if(result.code!==0){writePrivate(path.join(state,'bootstrap-error.log'),result.stderr);throw error('agent_bootstrap_failed');}
  const evidence={installed:true,checkedAt:new Date().toISOString(),vmId:current.vmId,sdkVersion:'0.3.316'};
  writePrivate(path.join(state,'agent-installed.json'),evidence);return evidence;
}
export async function chat(state,prompt,{resume,effort='low',onData}={}) {
  const status=await control(state),v=read(path.join(state,'verification.json'));
  if(!status.ready||!status.modelReady)throw error('model_workspace_not_ready');
  if(!verificationMatches(v,status))throw error('current_isolation_verification_required');
  const command='env -i HOME=/home/agent USER=agent LOGNAME=agent PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8 TZ=Asia/Taipei node /opt/starport/agent/agent.mjs';
  return guest(state,status.sshPort,command,{input:JSON.stringify({prompt,resume,effort}),timeout:900000,onData,maxBytes:16*1024*1024,boundedCapture:true});
}
export function verificationMatches(v,status,now=Date.now()) {
  const checked=Date.parse(v?.checkedAt),age=now-checked;
  return v?.passed===true&&Boolean(status.runId)&&Boolean(status.settingsDigest)&&v.vmId===status.vmId&&v.runId===status.runId&&v.settingsDigest===status.settingsDigest&&Number.isFinite(checked)&&age>=0&&age<=86400000;
}
export async function fileOperation(state,request) {
  const current=await control(state);if(!current.ready)throw error('workspace_not_ready');
  const result=await guest(state,current.sshPort,'env -i HOME=/home/agent PATH=/usr/bin:/bin LANG=C.UTF-8 python3 /opt/starport/agent/files.py',
    {input:JSON.stringify(request),timeout:120000,maxBytes:96*1024*1024});
  let value;try{value=JSON.parse(result.stdout);}catch{throw error('file_channel_unavailable');}
  if(result.code!==0||value.error)throw error(value.error||'file_channel_failed');return value;
}
export async function putFile(state,source,destination,{replace=false}={}) {
  const st=fs.lstatSync(source);if(!st.isFile()||st.isSymbolicLink()||st.size>64*1024*1024)throw error('file_transfer_limit');
  const data=fs.readFileSync(source),sha256=crypto.createHash('sha256').update(data).digest('hex');
  return fileOperation(state,{operation:'write',path:destination,data:data.toString('base64'),sha256,replace});
}
export async function getFile(state,source,destination) {
  const value=await fileOperation(state,{operation:'read',path:source});
  const data=Buffer.from(value.data,'base64');if(data.length!==value.bytes||crypto.createHash('sha256').update(data).digest('hex')!==value.sha256)throw error('download_integrity_mismatch');
  fs.writeFileSync(destination,data,{flag:'wx',mode:0o600});return {downloaded:true,bytes:value.bytes,sha256:value.sha256};
}
