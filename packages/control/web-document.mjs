import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {gzipSync} from 'node:zlib';

const root=fileURLToPath(new URL('./web/',import.meta.url));
const vendor=fileURLToPath(new URL('../../node_modules/@novnc/novnc/',import.meta.url));
const hash=text=>"'sha256-"+crypto.createHash('sha256').update(text).digest('base64')+"'";
let cached;
export function webDocument(){
  return cached??=compile().catch(error=>{cached=undefined;throw error;});
}
async function compile(){
  const result=await build({entryPoints:[path.join(root,'app.js')],bundle:true,write:false,
    format:'esm',platform:'browser',target:'es2022',minify:true,legalComments:'inline',
    plugins:[{name:'local-viewer',setup(context){context.onResolve({filter:/^\/novnc\/core\/rfb\.js$/},()=>({path:path.join(vendor,'core/rfb.js')}));}}]});
  const script=result.outputFiles[0].text.replace(/<\/script/gi,'<\\/script');
  // HTML parsing normalizes line endings before CSP checks inline content.
  const style=fs.readFileSync(path.join(root,'style.css'),'utf8').replace(/\r\n?/g,'\n');
  const html=fs.readFileSync(path.join(root,'index.html'),'utf8')
    .replace('<link rel="stylesheet" href="/style.css">',()=>'<style>'+style+'</style>')
    .replace('<script type="module" src="/app.js"></script>',()=>'<script type="module">'+script+'</script>');
  return {html,gzip:gzipSync(html),csp:`default-src 'self'; script-src 'self' ${hash(script)}; style-src 'self' ${hash(style)}; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`};
}
