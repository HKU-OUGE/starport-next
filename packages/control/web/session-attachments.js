import {bindFileDrop} from './file-transfer.js';

export function initAttachments({session,api,el,problem,change}){
  const $=id=>document.getElementById(id),files=new Map(),running=new Set();
  let queue=Promise.resolve();
  const key=id=>'starport-attachments-'+id;
  function get(id){try{return JSON.parse(sessionStorage.getItem(key(id))||'[]');}catch{return [];}}
  function save(id,value){sessionStorage.setItem(key(id),JSON.stringify(value));render();change();}
  function render(){
    const current=session(),list=current?get(current.id):[];
    $('session-attachments').replaceChildren(...list.map(file=>{
      const item=el('div',undefined,'attachment-chip');
      item.append(el('span',file.name),el('small',file.ready?`${Math.ceil(file.bytes/1024)} KB`:running.has(file.id)?'上传中…':!files.has(file.id)?'请重新选择':file.queued?'等待上传':'未上传'));
      if(!file.ready&&!file.queued&&!running.has(file.id)&&files.has(file.id)){
        const retry=el('button','重试','quiet');retry.type='button';retry.onclick=()=>enqueue(current.id,file);item.append(retry);
      }
      const remove=el('button','×','quiet');remove.type='button';remove.setAttribute('aria-label','移除附件 '+file.name);
      remove.disabled=current.locked||running.has(file.id);remove.onclick=()=>{files.delete(file.id);save(current.id,get(current.id).filter(f=>f.id!==file.id));};item.append(remove);return item;
    }));
    $('session-attach').disabled=!current||current.locked;
  }
  async function upload(id,item){
    if(running.has(item.id)||!files.has(item.id))return;
    running.add(item.id);render();change();
    try{
      const file=files.get(item.id),bytes=new Uint8Array(await file.arrayBuffer());let binary='';
      for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
      const sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');
      const result=await api('/api/sessions/'+id+'/attachments',{requestId:item.id,name:item.name,data:btoa(binary),sha256});
      save(id,get(id).map(f=>f.id===item.id?result:f));files.delete(item.id);
    }catch(e){save(id,get(id).map(f=>f.id===item.id?{...f,queued:false}:f));problem(e);}finally{running.delete(item.id);render();change();}
  }
  function enqueue(id,item){
    save(id,get(id).map(f=>f.id===item.id?{...f,queued:true}:f));
    queue=queue.then(()=>upload(id,item)).catch(problem);return queue;
  }
  async function add(selected){
    // Bind the whole batch before any await; switching sessions cannot reroute it.
    const current=session();if(!current||current.locked)throw Error('请先选择可用会话');
    const incoming=Array.from(selected),existing=get(current.id);
    if(incoming.length+existing.length>8)throw Error('每条消息最多 8 个附件');
    if(incoming.reduce((n,f)=>n+f.size,0)+existing.reduce((n,f)=>n+f.bytes,0)>128*1024*1024)throw Error('每条消息附件总量上限为 128 MiB');
    for(const file of incoming){
      if(!file.name||/[\\/\x00-\x1f\x7f]/.test(file.name)||['.','..'].includes(file.name)||new TextEncoder().encode(file.name).length>240)throw Error('文件名不受支持');
      if(file.size>64*1024*1024)throw Error('单文件上限为 64 MiB；大文件请使用项目文件夹');
    }
    const items=incoming.map(file=>{const item={id:crypto.randomUUID(),name:file.name,bytes:file.size,ready:false};files.set(item.id,file);return item;});
    save(current.id,[...existing,...items]);
    await Promise.all(items.map(item=>enqueue(current.id,item)));
  }
  $('session-attach').onclick=()=>$('session-files').click();
  $('session-files').onchange=()=>{const chosen=Array.from($('session-files').files);$('session-files').value='';add(chosen).catch(problem);};
  bindFileDrop($('session-drop'),add,problem);
  $('session-input').addEventListener('paste',event=>{
    const pasted=Array.from(event.clipboardData?.files||[]);if(!pasted.length)return;
    event.preventDefault();add(pasted).catch(problem);
  });
  return {render,ids:id=>get(id).filter(f=>f.ready).map(f=>f.id),
    blocked:id=>get(id).some(f=>!f.ready),
    clear(id,ids){save(id,get(id).filter(f=>!ids.includes(f.id)));}
  };
}
