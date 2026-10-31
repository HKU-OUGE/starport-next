import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validateConfig } from '../packages/config/model.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const names = execFileSync('git', ['ls-files','--cached','--others','--exclude-standard','-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const issues = [];
const checks = [
  ['private_key', /-----BEGIN (?:OPENSSH |RSA |EC |ENCRYPTED )?PRIVATE KEY-----[\r\n]/],
  ['provider_key', /\bsk-ant-[A-Za-z0-9_-]{20,}/],
  ['cloud_access_key', /\bLTAI[A-Za-z0-9]{12,}/],
  ['personal_host_path', /\/(?:home|Users)\/(?!agent\/|control\/)[a-zA-Z0-9_.-]+\//],
  ['personal_windows_path', /[A-Za-z]:\\Users\\[^\\\s]+\\/]
];
for (const name of [...new Set(names)]) {
  const file = path.join(root, name);
  if (!fs.existsSync(file)) continue;
  if (fs.lstatSync(file).isSymbolicLink()) { issues.push([name,'symlink']); continue; }
  if (fs.statSync(file).size > 2 * 1024 * 1024) { issues.push([name,'large_file']); continue; }
  const text = fs.readFileSync(file, 'utf8');
  for (const [label, pattern] of checks) if (pattern.test(text)) issues.push([name,label]);
  for (const email of text.matchAll(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g)) {
    if (!/^[^@]+@(?:[a-z0-9-]+\.)*example\.(?:com|org|net|invalid)$/.test(email[0])) issues.push([name,'non_example_email']);
  }
  if (name.endsWith('.md')) for (const m of text.matchAll(/!?\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (!target || /^[a-z]+:/i.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), target);
    if (!resolved.startsWith(root + path.sep) || !fs.existsSync(resolved)) issues.push([name,'broken_relative_link:' + target]);
  }
  if (name.startsWith('examples/') && name.endsWith('.json')) {
    try { validateConfig(JSON.parse(text)); } catch { issues.push([name,'invalid_example']); }
  }
}
if (issues.length) { console.error(JSON.stringify({ ok: false, issues }, null, 2)); process.exitCode = 1; }
else console.log(JSON.stringify({ ok: true, files: new Set(names).size, checks: ['links','portable-examples','common-secret-patterns','host-paths','example-emails','file-shape'], scope: 'heuristic-source-audit-not-anonymity-proof' }, null, 2));
