// Linux acceptance of the shared namespace/pipe code, not Windows WSL validation.
import fs from 'node:fs';
import path from 'node:path';
import { spawn,spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv } from '../packages/runtime/common.mjs';
const source=fileURLToPath(new URL('../packages/wsl/',import.meta.url));
export function fixture(directory){
  const code=path.join(directory,'code'),etc=path.join(code,'etc'),pub=path.join(code,'public');
  fs.mkdirSync(pub,{recursive:true});fs.mkdirSync(etc,{recursive:true});
  fs.mkdirSync(path.join(etc,'locale-data'),{recursive:true});
  const locale=spawnSync('localedef',['--no-archive','-i','zh_TW','-f','UTF-8',path.join(etc,'locale-data','zh_TW.utf8')]);
  if(locale.status!==0)throw Error('test_locale_generation_failed');
  for(const [name,content] of Object.entries({passwd:'root:x:0:0:root:/root:/bin/false\nagent:x:1000:1000:agent:/home/agent:/bin/bash\n',group:'root:x:0:\nagent:x:1000:\n',hosts:'127.0.0.1 localhost starship\n',hostname:'starship\n','resolv.conf':'nameserver 127.0.0.1\n','nsswitch.conf':'passwd: files\ngroup: files\nhosts: files dns\n',timezone:'Asia/Taipei\n'}))fs.writeFileSync(path.join(etc,name),content);
  fs.mkdirSync(path.join(etc,'ssl','certs'),{recursive:true});fs.copyFileSync('/etc/ssl/certs/ca-certificates.crt',path.join(etc,'ssl','certs','ca-certificates.crt'));
  fs.copyFileSync('/usr/share/zoneinfo/Asia/Taipei',path.join(etc,'localtime'));
  fs.copyFileSync(path.join(source,'guest-entry.py'),path.join(pub,'guest-entry.py'));
  fs.copyFileSync(new URL('../packages/runtime/guest/files.py',import.meta.url),path.join(pub,'files.py'));
  const python=`import importlib.util,pathlib,os
s=importlib.util.spec_from_file_location('runner',${JSON.stringify(path.join(source,'runner.py'))})
m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
m.serve(pathlib.Path(${JSON.stringify(path.join(directory,'workspaces'))}),pathlib.Path(${JSON.stringify(code)}))`;
  return ()=>spawn('/usr/bin/python3',['-I','-B','-c',python],{env:cleanEnv(),stdio:['pipe','pipe','pipe']});
}
