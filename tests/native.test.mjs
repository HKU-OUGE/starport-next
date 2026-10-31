import test from 'node:test';
import assert from 'node:assert/strict';
import {nativeFiles,nativeEnvironment,NATIVE_HOSTS} from '../packages/runtime/native.mjs';
import {authority} from '../packages/runtime/egress.mjs';
test('account client uses a separate native config and never inherits API or OAuth credentials',()=>{
  assert.equal(nativeEnvironment.CLAUDE_CONFIG_DIR,'/home/agent/.claude-account');
  for(const key of ['ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','CLAUDE_CODE_OAUTH_TOKEN','SSH_AUTH_SOCK'])assert.equal(nativeEnvironment[key],undefined);
  const files=nativeFiles();
  assert.match(files['/usr/local/bin/starport-account-login'],/auth login --claudeai/);
  assert.ok(!files['/usr/local/bin/starport-account-login'].includes('agent-sdk'));
});
test('native applications use the network-restricted user slice and limit clipboard to explicit text transfer',()=>{
  const files=nativeFiles(),service=files['/etc/systemd/system/starport-native.service'];
  assert.match(service,/User=agent/);assert.match(service,/Slice=user-1001.slice/);
  const session=files['/usr/local/bin/starport-native-session'];
  assert.match(session,/-SendCutText=1/);assert.match(session,/-AcceptCutText=1/);
  assert.match(session,/-MaxCutText=1048576/);assert.match(session,/-SendPrimary=0/);
  assert.match(session,/-localhost/);assert.match(session,/127\.0\.0\.1:6080/);
  assert.match(session,/-SecurityTypes VncAuth/);
});
test('authentication browser remains inside the VM with fixed proxy and no direct QUIC/WebRTC',()=>{
  const files=nativeFiles(),browser=files['/usr/local/bin/starport-browser'];
  assert.match(browser,/\/usr\/bin\/google-chrome-stable/);assert.ok(!browser.includes('no-sandbox'));
  const p=JSON.parse(files['/etc/opt/chrome/policies/managed/starport.json']);
  assert.equal(p.ProxyMode,'fixed_servers');assert.equal(p.ProxyServer,'http://127.0.0.1:13128');
  assert.equal(p.DnsOverHttpsMode,'off');assert.equal(p.QuicAllowed,false);
  assert.equal(p.WebRtcIPHandling,'disable_non_proxied_udp');assert.equal(p.SyncDisabled,true);
  assert.equal(authority('platform.claude.com:443',NATIVE_HOSTS),'platform.claude.com');
  assert.throws(()=>authority('claude.ai.evil.example:443',NATIVE_HOSTS));
});
test('native mode rejects an API key argument before reading credentials or launching a VM',async()=>{
  const {run}=await import('../packages/runtime/common.mjs');
  const result=await run(process.execPath,['bin/starport.mjs','local','start','--state','private/not-created','--client','native','--api-key-file','private/not-readable']);
  assert.notEqual(result.code,0);
  assert.match(result.stderr,/native_account_mode_does_not_accept_api_key/);
  assert.ok(!result.stderr.includes('ENOENT'));
});
test('arm64 uses an internal Firefox with locked proxy rather than a host browser fallback',()=>{
  const files=nativeFiles('arm64');
  assert.match(files['/usr/local/bin/starport-browser'],/\/usr\/bin\/firefox/);
  assert.ok(!files['/usr/local/bin/starport-browser'].includes('google-chrome'));
  const p=JSON.parse(files['/etc/firefox/policies/policies.json']).policies;
  assert.equal(p.Proxy.Mode,'manual');assert.equal(p.Proxy.Locked,true);
  assert.equal(p.Proxy.HTTPProxy,'127.0.0.1:13128');assert.equal(p.Proxy.UseHTTPProxyForAllProtocols,true);
  assert.equal(p.DNSOverHTTPS.Enabled,false);assert.equal(p.Preferences['media.peerconnection.enabled'].Value,false);
  assert.throws(()=>nativeFiles('unknown'),/unsupported_guest_architecture/);
});
