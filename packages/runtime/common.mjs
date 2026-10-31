import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';

export const error = code => Object.assign(new Error(code), { code });
export function cleanEnv(extra = {}) {
  const env = {};
  for (const key of ['PATH','SystemRoot','WINDIR','COMSPEC','PATHEXT','TEMP','TMP','TMPDIR'])
    if (process.env[key]) env[key] = process.env[key];
  return { ...env, LANG: 'C.UTF-8', TZ: 'UTC', ...extra };
}
export function privateDir(target) {
  target = path.resolve(target);
  if (/[\x00-\x1f,]/.test(target)) throw error('unsupported_state_path');
  let current = target;
  while (true) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw error('symlink_state_rejected'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(current); if (parent === current) break; current = parent;
  }
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  if (process.platform === 'win32') {
    const who = spawnSync('whoami.exe', ['/user','/fo','csv','/nh'], { encoding: 'utf8', windowsHide: true });
    const sid = who.stdout?.match(/S-1-\d+(?:-\d+)+/g)?.at(-1);
    if (who.status !== 0 || !sid || spawnSync('icacls.exe', [target,'/inheritance:r','/grant:r',`*${sid}:(OI)(CI)F`], { windowsHide:true, stdio:'ignore' }).status !== 0)
      throw error('private_directory_acl_failed');
  } else fs.chmodSync(target, 0o700);
  return target;
}
export function writePrivate(file, value) {
  const tmp = file + '.' + crypto.randomBytes(8).toString('hex') + '.partial';
  fs.writeFileSync(tmp, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode:0o600, flag:'wx' });
  fs.renameSync(tmp, file);
}
export const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export async function hash(file) {
  const h = crypto.createHash('sha256');
  for await (const part of fs.createReadStream(file)) h.update(part);
  return h.digest('hex');
}
export function executable(name) {
  const suffixes = process.platform === 'win32' ? ['.exe',''] : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter);
  if (process.platform === 'win32') {
    const windows=process.env.SystemRoot||'C:\\Windows',programs=process.env.ProgramFiles||'C:\\Program Files';
    // Prefer Microsoft's OpenSSH over a Git/MSYS executable with different path semantics.
    if(['ssh','ssh-keygen'].includes(name))dirs.unshift(path.join(windows,'System32','OpenSSH'),path.join(programs,'OpenSSH'));
    dirs.push(path.join(programs,'qemu'),path.join(windows,'System32','OpenSSH'));
  }
  if (process.platform === 'darwin') dirs.push('/opt/homebrew/bin','/usr/local/bin','/opt/homebrew/opt/node@22/bin','/usr/local/opt/node@22/bin');
  for (const dir of dirs) for (const suffix of suffixes) {
    const candidate = path.resolve(dir, name + suffix);
    try { fs.accessSync(candidate, fs.constants.X_OK); if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}
export function run(file, args, { input, timeout = 60000, maxBytes = 8 * 1024 * 1024, boundedCapture = false, onData, env, cwd } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell:false, windowsHide:true, env:env || cleanEnv(), cwd, stdio:['pipe','pipe','pipe'] });
    let stdout = '', stderr = '', size = 0, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill(); reject(error('process_timeout')); }, timeout);
    const collect = (kind, data) => {
      size += data.length;
      if (!boundedCapture && size > maxBytes) { if (!failed) { failed = true; child.kill(); reject(error('process_output_limit')); } return; }
      if (kind === 'stdout') { stdout += data; onData?.(data.toString()); } else stderr += data;
      if (boundedCapture) { stdout=stdout.slice(-maxBytes);stderr=stderr.slice(-Math.min(maxBytes,1024*1024)); }
    };
    child.stdout.on('data', d => collect('stdout', d)); child.stderr.on('data', d => collect('stderr', d));
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); if (!failed) { failed = true; reject(error('executable_failed')); } });
    child.on('close', code => { clearTimeout(timer); if (!failed) resolve({ code, stdout, stderr }); });
    child.stdin.end(input);
  });
}
export function assertSpace(dir, bytes) {
  const stat = fs.statfsSync(dir); const available = Number(stat.bavail) * Number(stat.bsize);
  if (available < bytes) throw error('insufficient_disk_space');
  return available;
}
export function architecture(platform = process.platform, arch = process.arch) {
  if (!['linux','darwin','win32'].includes(platform) || !['x64','arm64'].includes(arch)) throw error('unsupported_host_platform');
  if (platform === 'win32' && arch !== 'x64') throw error('windows_arm_runtime_not_validated');
  return { arch, guest: arch === 'x64' ? 'amd64' : 'arm64', qemu: arch === 'x64' ? 'qemu-system-x86_64' : 'qemu-system-aarch64',
    accelerator: platform === 'linux' ? 'kvm' : platform === 'darwin' ? 'hvf' : 'whpx' };
}
export function checkMemory(memoryMiB) {
  if (!Number.isInteger(memoryMiB) || memoryMiB < 1024 || memoryMiB > 65536) throw error('invalid_memory_budget');
  if (os.totalmem() < (memoryMiB + 2048) * 1024 * 1024) throw error('insufficient_host_memory');
}
