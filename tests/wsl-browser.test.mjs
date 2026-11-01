import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {wslBrowserScript} from '../packages/wsl/clients.mjs';

test('browser opener selects the session display and preserves proxy and URL arguments',{skip:process.platform==='win32'},()=>{
  const script=wslBrowserScript('x64').replace('exec /usr/bin/google-chrome-stable',"exec printf '%s\\n'");
  for(const platform of ['wayland','x11']){
    const r=spawnSync('/bin/bash',['-s','--','https://example.com/'],{input:script,encoding:'utf8',env:{PATH:'/usr/bin:/bin',HOME:'/home/agent',ELECTRON_OZONE_PLATFORM_HINT:platform}});
    assert.equal(r.status,0,r.stderr);
    const args=r.stdout.trim().split('\n');
    assert.ok(args.includes('--ozone-platform='+platform));
    assert.ok(args.includes('--proxy-server=http://127.0.0.1:13128'));
    assert.equal(args.at(-1),'https://example.com/');
    assert.ok(!args.includes('--no-sandbox'));
  }
});
