// Capture the destination before awaiting bytes: changing workspaces mid-upload
// must never redirect a drop into a different project.
export async function uploadFiles(selectedFiles,{workspace,directory,write,digest,confirmOverwrite,progress=()=>{},existing=[]}){
 const files=Array.from(selectedFiles),names=new Set(existing);
 for(const f of files){
  if(!f.name||/[\\/\x00-\x1f]/.test(f.name)||['.','..'].includes(f.name))throw Error('文件名不受支持');
  if(f.size>64*1024*1024)throw Error(`${f.name}：单文件上限为 64 MiB；大文件请使用“打开项目文件夹”`);
 }
 let complete=0;
 for(const f of files){
  if(names.has(f.name)&&!await confirmOverwrite(f.name))continue;
  progress(`${complete}/${files.length} · ${f.name}`);
  const bytes=new Uint8Array(await f.arrayBuffer());let binary='';
  for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  await write(workspace,{operation:'write',path:directory?directory+'/'+f.name:f.name,data:btoa(binary),sha256:await digest(bytes)});
  names.add(f.name);complete++;
 }
 progress(`已上传 ${complete} 个文件`);return complete;
}
export function bindFileDrop(element,upload,onError){
 element.addEventListener('dragover',e=>{if([...e.dataTransfer.types].includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy';element.classList.add('drop-active');}});
 element.addEventListener('dragleave',e=>{if(!element.contains(e.relatedTarget))element.classList.remove('drop-active');});
 element.addEventListener('drop',e=>{
  e.preventDefault();element.classList.remove('drop-active');
  const items=Array.from(e.dataTransfer.items||[]);
  if(items.some(i=>i.webkitGetAsEntry?.()?.isDirectory)){onError(Error('文件夹请通过“打开项目文件夹”拖入；网页支持批量文件。'));return;}
  // Never interpret dragged HTML, URLs or local file paths as upload instructions.
  const files=Array.from(e.dataTransfer.files||[]);if(files.length)Promise.resolve(upload(files)).catch(onError);
 });
}
