import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { defaultConfig, validateConfig } from '../packages/config/model.mjs';
import { encrypt } from '../packages/config/crypto.mjs';
import { bundle, decodeBundle, preview } from '../packages/config/portable.mjs';
import { createProfile, exportProfile, importProfile, loadProfile, readJson, writeExport } from '../packages/config/store.mjs';
import { plan } from '../packages/planner/index.mjs';
import { readiness, resumeDecision } from '../packages/contracts/readiness.mjs';

const password = 'example test passphrase only';
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'starport-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function sample() {
  const config = defaultConfig();
  const marker = crypto.randomBytes(24).toString('hex');
  return { config, marker, privateValues: { [config.engine.providerRef]: { kind: 'model-provider', provider: 'anthropic-api', endpoint: 'https://api.anthropic.com', token: marker } } };
}
function legacy() {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    format: 'starport-pi-profile', version: 1, includesSecrets: true,
    preferences: { model: 'claude-example', effort: 'high' },
    network: { subscriptions: [{ id: 'sub-example', nodes: [{ name: 'example', type: 'trojan', server: 'node.example.com', port: 443, password: 'example-only', udp: false }], hosts: {} }], selected: 'sub-example:0' },
    servers: [{ name: 'compute-a', mode: 'dsw', instanceId: 'dsw-aaaaaaaaaaaa1234', region: 'example-region', user: 'worker',
      budget: { cpus: 8, memoryGiB: 32, gpus: [0] }, privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
      credentials: { accesskeyid: 'example-id', accesskeysecret: 'example-secret' }, initialized: true,
      identityFile: 'old-device-identity', knownHostsFile: 'old-host-keys' }],
    anthropicApiKey: 'example-api-value',
    cloudflare: { zone: 'example.com', prefix: 'console-a', allowedEmails: ['operator@example.com'], apiToken: 'example-cf-value', audience: 'old-audience', tunnelToken: 'old-tunnel' },
    addons: { skills: [{ id: 'example-skill', content: 'Example instructions.', enabled: true }], mcp: [], plugins: [] },
    localRuntime: { requested: true }, runningPid: 999
  };
}
async function sealLegacy(value) {
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = await promisify(crypto.scrypt)(password, salt, 32);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from('starport-pi-profile:1'));
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return { format: 'starport-pi-profile-encrypted', version: 1, kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') };
}

test('all portable presets validate and produce an explicitly non-deploying plan', () => {
  for (const name of ['desktop-dsw','single-machine','server-hosted']) {
    const config = readJson(new URL('../examples/' + name + '.json', import.meta.url));
    assert.equal(validateConfig(config).topology, name);
    const p = plan(config); assert.equal(p.deploymentReady, false); assert.equal(p.willStartServices, false);
    assert.ok(p.blockers.includes('live_acceptance_required'));
  }
});
test('network settings cannot enable direct fallback or a model-controlled policy', () => {
  for (const [key, value] of [['directFallback',true],['failClosed',false],['policyOwner','agent'],['dns','host'],['ipv6','enabled']]) {
    const c = defaultConfig(); c.network[key] = value;
    assert.throws(() => validateConfig(c), /network_boundary_weakened/);
  }
});
test('configuration cannot weaken whole-agent execution to a host shell', () => {
  for (const [key, value] of [['hostShell',true],['hostMounts',true],['importHostEnv',true],['scope','bash-only']]) {
    const c = defaultConfig(); c.execution[key] = value;
    assert.throws(() => validateConfig(c), /execution_boundary_weakened/);
  }
});
test('host paths and traversal cannot become portable data paths', () => {
  for (const value of ['../outside','/absolute','C:\\private','cache/../outside','cache//x','cache\0']) {
    const c = defaultConfig(); c.paths.cache = value;
    assert.throws(() => validateConfig(c), /relative_paths_required/);
  }
  const c = defaultConfig(); c.paths.cache = 'state/cache';
  assert.throws(() => validateConfig(c), /overlapping_profile_paths/);
});
test('read-only dependency versions cannot grant a writable host mount', () => {
  const c = defaultConfig(); c.dependencies = [{ id: 'training', release: 'v1', mount: 'dependencies', readonly: false }];
  assert.throws(() => validateConfig(c), /invalid_dependency_release/);
});
test('secret-bearing plaintext bundles are rejected', async () => {
  const f = sample();
  await assert.rejects(decodeBundle(bundle(f.config, f.privateValues, { includeSecrets: true })), /encrypted_profile_required/);
});
test('encrypted bundle round trip and preview do not expose secret values', async () => {
  const f = sample(); const sealed = await encrypt(bundle(f.config, f.privateValues, { includeSecrets: true }), password);
  assert.ok(!JSON.stringify(sealed).includes(f.marker));
  const decoded = await decodeBundle(sealed, password);
  assert.equal(decoded.privateValues[f.config.engine.providerRef].token, f.marker);
  assert.ok(!JSON.stringify(preview(decoded)).includes(f.marker));
  assert.equal(preview(decoded).willContactServers, false);
});
test('wrong password and ciphertext mutation fail before import writes', async t => {
  const dir = fixture(t), f = sample(), sealed = await encrypt(bundle(f.config, f.privateValues, { includeSecrets: true }), password);
  await assert.rejects(importProfile(path.join(dir, 'wrong'), sealed, 'another long wrong password'), /integrity/);
  const broken = structuredClone(sealed), bytes = Buffer.from(broken.data, 'base64'); bytes[0] ^= 1; broken.data = bytes.toString('base64');
  await assert.rejects(importProfile(path.join(dir, 'broken'), broken, password), /integrity/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('invalid configuration is not partially imported', async t => {
  const dir = fixture(t), c = defaultConfig(); c.execution.hostShell = true;
  const value = { format: 'starport-profile', version: 1, includesSecrets: false, config: c, privateValues: {} };
  await assert.rejects(importProfile(path.join(dir, 'profile'), value), /execution_boundary/);
  assert.deepEqual(fs.readdirSync(dir), []);
});
test('import stores secrets only in an encrypted vault and resets all readiness', async t => {
  const dir = fixture(t), target = path.join(dir, 'profile'), f = sample();
  const sealed = await encrypt(bundle(f.config, f.privateValues, { includeSecrets: true }), password);
  await importProfile(target, sealed, password);
  for (const name of fs.readdirSync(target)) assert.ok(!fs.readFileSync(path.join(target, name), 'utf8').includes(f.marker));
  const state = readJson(path.join(target, 'verification.json'));
  assert.equal(state.state, 'unverified'); assert.equal(state.startup, 'disabled'); assert.equal(state.access, 'not-enrolled');
  const full = await loadProfile(target, password, { unlock: true }); assert.equal(full.privateValues[f.config.engine.providerRef].token, f.marker);
});
test('existing profile is preserved; concurrent imports never merge partial profiles', async t => {
  const dir = fixture(t), target = path.join(dir, 'profile'), f = sample(), plain = bundle(f.config);
  const results = await Promise.allSettled([importProfile(target, plain), importProfile(target, plain)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const before = fs.readFileSync(path.join(target, 'config.json'));
  await assert.rejects(importProfile(target, plain), /destination_exists/);
  assert.deepEqual(fs.readFileSync(path.join(target, 'config.json')), before);
});
test('configuration-only export omits private connection data and is portable', async t => {
  const dir = fixture(t), target = path.join(dir, 'profile'), f = sample();
  await importProfile(target, await encrypt(bundle(f.config, f.privateValues, { includeSecrets: true }), password), password);
  const exported = await exportProfile(target);
  assert.deepEqual(exported.privateValues, {}); assert.equal(exported.includesSecrets, false);
  assert.ok(!JSON.stringify(exported).includes(f.marker));
  const another = path.join(dir, 'another'); await importProfile(another, exported);
  assert.deepEqual((await loadProfile(another)).config, f.config);
});
test('encrypted export can be imported without original-machine paths', async t => {
  const dir = fixture(t), one = path.join(dir, 'one'), two = path.join(dir, 'two'), f = sample();
  await importProfile(one, await encrypt(bundle(f.config, f.privateValues, { includeSecrets: true }), password), password);
  const exported = await exportProfile(one, password, { includeSecrets: true });
  await importProfile(two, exported, password);
  assert.equal((await loadProfile(two, password, { unlock: true })).privateValues[f.config.engine.providerRef].token, f.marker);
});
test('Pi v1 import migrates credentials but drops trust, tokens, paths and activation', async t => {
  const dir = fixture(t), value = legacy(), decoded = await decodeBundle(await sealLegacy(value), password);
  assert.equal(decoded.source, 'starport-pi-v1'); assert.equal(decoded.config.nodes[0].budget.gpus.length, 1);
  assert.equal(decoded.privateValues['secret://connection-compute-a'].instanceId, value.servers[0].instanceId);
  assert.equal(decoded.privateValues['secret://staged-addons'].skills[0].enabled, false);
  const serialized = JSON.stringify(decoded);
  for (const omitted of ['old-audience','old-tunnel','old-device-identity','old-host-keys','runningPid','initialized']) assert.ok(!serialized.includes(omitted));
  const target = path.join(dir, 'pi'); await importProfile(target, await sealLegacy(value), password);
  assert.equal(readJson(path.join(target, 'verification.json')).nodes[0].ready, false);
});
test('Pi placeholder instance and provider direct rules cannot be activated by import', async () => {
  const bad = legacy(); bad.servers[0].instanceId = 'dsw-proxy';
  await assert.rejects(decodeBundle(await sealLegacy(bad), password), /invalid_dsw_identity/);
  const routing = legacy(); routing.network.subscriptions[0].nodes[0].type = 'direct';
  await assert.rejects(decodeBundle(await sealLegacy(routing), password), /invalid_proxy_node/);
});
test('new configuration rejects imported readiness, unreferenced secrets and prototype keys', async () => {
  const f = sample(); f.config.ready = true;
  assert.throws(() => validateConfig(f.config), /invalid_configuration/);
  const other = sample(); other.privateValues['secret://unrelated'] = { token: 'example' };
  assert.throws(() => bundle(other.config, other.privateValues), /unreferenced_private_value/);
  const b = bundle(defaultConfig()); b.extra = JSON.parse('{"__proto__":{"polluted":true}}');
  await assert.rejects(decodeBundle(b), /unsafe_profile_key/);
});
test('export never replaces an existing destination', t => {
  const dir = fixture(t), file = path.join(dir, 'backup.spx'); writeExport(file, { example: 1 });
  assert.throws(() => writeExport(file, { example: 2 }), /destination_exists/);
  assert.deepEqual(readJson(file), { example: 1 }); assert.deepEqual(fs.readdirSync(dir), ['backup.spx']);
});
test('symlink destination is rejected without changing its target', async t => {
  const dir = fixture(t), actual = path.join(dir, 'actual'); fs.mkdirSync(actual);
  const link = path.join(dir, 'link');
  try { fs.symlinkSync(actual, link, 'dir'); } catch (e) { if (e.code === 'EPERM') return t.skip('Symlink privilege unavailable'); throw e; }
  assert.throws(() => createProfile(path.join(link, 'profile'), defaultConfig()), /symlink_destination/);
  assert.deepEqual(fs.readdirSync(actual), []);
});
test('node readiness requires fresh complete evidence and honors admission pause', () => {
  const good = { checkedAt: 100, generation: 'a', cloudState: 'running', ssh: true, runtime: true, isolation: true, egress: true, capacity: true };
  assert.equal(readiness(good, { now: 110, generation: 'a' }).ready, true);
  for (const key of ['ssh','runtime','isolation','egress','capacity']) assert.equal(readiness({ ...good, [key]: false }, { now: 110, generation: 'a' }).ready, false);
  assert.equal(readiness(good, { now: 230, generation: 'a' }).reason, 'stale');
  assert.equal(readiness(good, { now: 110, generation: 'b' }).reason, 'configuration_changed');
  for (const generation of [undefined, null, '', ' ']) {
    assert.equal(readiness({ ...good, generation }, { now: 110, generation }).reason, 'configuration_changed');
  }
  assert.equal(readiness(good, { now: 110, generation: 'a', paused: true }).reason, 'admission_paused');
});
test('idle stop recovery requires authorization and an unambiguous lifecycle record', () => {
  const stopped = { checkedAt: 100, cloudState: 'stopped', stopReason: 'inactivity' };
  assert.equal(resumeDecision(stopped, { now: 110 }).action, 'ask');
  assert.equal(resumeDecision(stopped, { now: 110, authorized: true }).action, 'start-once');
  assert.equal(resumeDecision({ ...stopped, startOperation: 'recorded' }, { now: 110, authorized: true }).action, 'reconcile');
  assert.equal(resumeDecision({ ...stopped, stopReason: 'unknown' }, { now: 110, authorized: true }).action, 'inspect');
  assert.equal(resumeDecision({ ...stopped, cloudState: 'recovering' }, { now: 110, authorized: true }).action, 'none');
});
