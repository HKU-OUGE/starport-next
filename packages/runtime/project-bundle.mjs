import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
const source = fileURLToPath(new URL('../wsl/', import.meta.url));
export const bundleNames=['runner.py','guest-entry.py','native-session.py','ime.py','ime-check.html','sdk-agent.mjs','client-status.py','compute-mcp.py','configure-compute.py','COMPUTE-AGENT.md','files.py','compute-client.py'];
export function runtimeBundle(){
  const files={};for(const name of bundleNames.filter(n=>!['files.py','compute-client.py'].includes(n)))files[name]=fs.readFileSync(path.join(source,name)).toString('base64');
  files['files.py']=fs.readFileSync(new URL('./guest/files.py',import.meta.url)).toString('base64');
  files['compute-client.py']=fs.readFileSync(new URL('../../scripts/compute-client.py',import.meta.url)).toString('base64');
  const digests=Object.fromEntries(Object.entries(files).map(([n,b])=>[n,crypto.createHash('sha256').update(Buffer.from(b,'base64')).digest('hex')]));
  return {files,digests,digest:crypto.createHash('sha256').update(JSON.stringify(digests)).digest('hex')};
}
