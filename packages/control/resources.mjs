// Explicit public schema: host paths and publication process details never cross it.
export function publicResources(value){
  const fields=['id','name','kind','phase','version','bytes','files','created_at','copy_mode','embedded_source_paths','python_entry','compatibility','readonly','path'];
  return {resources:(Array.isArray(value?.resources)?value.resources:[]).filter(r=>/^[a-f0-9]{32}$/.test(r.id||'')&&['python','data'].includes(r.kind)).map(r=>{
    const out=Object.fromEntries(fields.filter(k=>r[k]!==undefined).map(k=>[k,r[k]]));
    out.path=(r.kind==='python'?'/dependencies/':'/datasets/')+r.id;out.readonly=true;
    if(r.error)out.error=/^[a-z][a-z0-9_]{1,79}$/.test(r.error)?r.error:'resource_operation_failed';
    return out;
  })};
}

export function mountSelection(value=[]){
  if(!Array.isArray(value)||value.length>16||new Set(value.map(v=>v?.id)).size!==value.length||value.some(v=>!v||Object.keys(v).sort().join(',')!=='id,version'||! /^[a-f0-9]{32}$/.test(v.id)||! /^[a-f0-9]{64}$/.test(v.version)))throw Error('invalid_resource_selection');
  return value.map(({id,version})=>({id,version}));
}
