import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {gunzipSync} from 'node:zlib';
import {webDocument} from '../packages/control/web-document.mjs';

test('first response includes the full interface and viewer with matching CSP hashes',async()=>{
  const page=await webDocument();
  const scripts=[...page.html.matchAll(/<script type="module">([\s\S]*?)<\/script>/g)];
  const styles=[...page.html.matchAll(/<style>([\s\S]*?)<\/style>/g)];
  assert.equal(scripts.length,1);assert.equal(styles.length,1);
  assert.doesNotMatch(page.html,/<script[^>]+src=/);
  assert.doesNotMatch(page.html,/<link[^>]+stylesheet/);
  assert.doesNotMatch(scripts[0][1],/import\(["']\/novnc\//);
  for(const [,content] of [...scripts,...styles])assert.ok(page.csp.includes("'sha256-"+crypto.createHash('sha256').update(content.replace(/\r\n?/g,'\n')).digest('base64')+"'"));
  assert.equal(gunzipSync(page.gzip).toString('utf8'),page.html);
  assert.match(page.html,/<section id="startup" class="box">/);
  assert.match(page.html,/正在连接控制中心/);
  assert.doesNotMatch(page.csp,/unsafe-inline|unsafe-eval/);
});
