import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { bundle, decodeBundle, preview } from './portable.mjs';
import { encrypt, MAX_BYTES } from './crypto.mjs';
import { fail, validateConfig } from './model.mjs';

function noLinks(target) {
  let p = path.resolve(target);
  while (true) {
    try { if (fs.lstatSync(p).isSymbolicLink()) fail('symlink_destination_rejected'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(p); if (parent === p) break; p = parent;
  }
}
function protect(directory) {
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); return; }
  const who = spawnSync('whoami.exe', ['/user','/fo','csv','/nh'], { encoding: 'utf8', windowsHide: true });
  const sid = who.stdout?.match(/S-1-\d+(?:-\d+)+/g)?.at(-1);
  if (who.status !== 0 || !sid) fail('windows_identity_unavailable');
  const r = spawnSync('icacls.exe', [directory, '/inheritance:r', '/grant:r', `*${sid}:(OI)(CI)F`], { windowsHide: true, stdio: 'pipe' });
  if (r.status !== 0) fail('private_directory_acl_failed');
}
export function readJson(file) {
  if (file instanceof URL) file = fileURLToPath(file);
  noLinks(file);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES * 2) fail('invalid_profile_file');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } catch (e) { if (e instanceof SyntaxError) fail('invalid_json'); throw e; }
  finally { fs.closeSync(fd); }
}
export function createProfile(target, config) {
  return commit(target, validateConfig(config), null, { source: 'new-profile', warnings: [] });
}
function commit(target, config, envelope, receipt) {
  target = path.resolve(target); noLinks(target);
  const parent = path.dirname(target);
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) fail('destination_parent_required');
  // Claim the final directory atomically. A failed import never overwrites an existing profile.
  try { fs.mkdirSync(target, { mode: 0o700 }); }
  catch (e) { if (e.code === 'EEXIST') fail('profile_destination_exists'); throw e; }
  try {
    protect(target);
    const write = (name, data) => fs.writeFileSync(path.join(target, name), JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    write('config.json', config);
    if (envelope) write('vault.spx', envelope);
    write('import-receipt.json', { format: 1, importedAt: new Date().toISOString(), ...receipt });
    // No host keys, cloud IDs, activation receipts, PIDs, or old ready flags are copied.
    write('verification.json', { format: 1, state: 'unverified', nodes: config.nodes.map(n => ({ id: n.id, ready: false })),
      egress: 'unverified', access: 'not-enrolled', startup: 'disabled' });
    write('profile.json', { format: 1, committed: true }); // Written last; readers reject incomplete profiles.
    return { imported: true, verified: false, startedServices: false, importedSecrets: Boolean(envelope) };
  } catch (e) { fs.rmSync(target, { recursive: true, force: true }); throw e; }
}
export async function importProfile(target, value, password) {
  const decoded = await decodeBundle(value, password);
  const full = bundle(decoded.config, decoded.privateValues, { includeSecrets: true });
  const envelope = Object.keys(decoded.privateValues).length ? await encrypt(full, password) : null;
  return { ...commit(target, decoded.config, envelope, { source: decoded.source, warnings: decoded.warnings }), preview: preview(decoded) };
}
export async function loadProfile(target, password, { unlock = false } = {}) {
  noLinks(target);
  if (readJson(path.join(target, 'profile.json')).committed !== true) fail('incomplete_profile');
  const config = validateConfig(readJson(path.join(target, 'config.json')));
  let privateValues = {};
  if (unlock && fs.existsSync(path.join(target, 'vault.spx'))) {
    const decoded = await decodeBundle(readJson(path.join(target, 'vault.spx')), password);
    if (JSON.stringify(decoded.config) !== JSON.stringify(config)) fail('profile_vault_configuration_mismatch');
    privateValues = decoded.privateValues;
  }
  return { config, privateValues };
}
export async function exportProfile(target, password, { includeSecrets = false } = {}) {
  const { config, privateValues } = await loadProfile(target, password, { unlock: includeSecrets });
  const value = bundle(config, privateValues, { includeSecrets });
  return includeSecrets ? await encrypt(value, password) : value;
}
export function writeExport(file, value) {
  noLinks(file); const parent = path.dirname(path.resolve(file));
  if (!fs.existsSync(parent)) fail('destination_parent_required');
  // The encrypted output contains no plaintext secret. Configuration-only exports contain references.
  const temp = path.join(parent, '.starport-export-' + crypto.randomBytes(12).toString('hex'));
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.linkSync(temp, file); // Atomic, no replacement of an existing export.
  } catch (e) { if (e.code === 'EEXIST') fail('export_destination_exists'); throw e; }
  finally { fs.rmSync(temp, { force: true }); }
}
