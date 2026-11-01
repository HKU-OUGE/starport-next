import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {privateDir,writePrivate,read,error} from '../runtime/common.mjs';

const idPattern=/^[a-f0-9]{32}$/;
const uuidPattern=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const now=()=>new Date().toISOString();
const digest=value=>crypto.createHash('sha256').update(value).digest('hex');
const maxLogBytes=64*1024*1024;

// Control owns the registry; the SDK owns conversation context in the persistent
// project HOME. A browser cannot supply an SDK resume ID or an execution path.
export function createSessions(state,{runtime,authorize,workspaces,model}={}){
  const dir=privateDir(path.join(state,'sessions')),rows=new Map(),live=new Map();
  let closed=false;
  const meta=id=>path.join(dir,id+'.json'),log=id=>path.join(dir,id+'.jsonl');
  function safe(file){if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw error('session_file_invalid');}
  function save(row){row.updatedAt=now();safe(meta(row.id));writePrivate(meta(row.id),row);}
  function events(row){safe(log(row.id));if(!fs.existsSync(log(row.id)))return [];
    if(fs.statSync(log(row.id)).size>maxLogBytes+65536)throw error('session_history_too_large');
    const lines=fs.readFileSync(log(row.id),'utf8').split('\n'),result=[];
    for(let i=0;i<lines.length;i++){if(!lines[i])continue;try{const value=JSON.parse(lines[i]);if(value.seq!==result.length+1)throw Error();result.push(value);}catch{throw error('session_history_requires_reconciliation');}}
    return result;
  }
  function append(row,value){safe(log(row.id));const entry={...value,seq:row.cursor+1,at:now()},line=JSON.stringify(entry)+'\n';
    if((fs.existsSync(log(row.id))?fs.statSync(log(row.id)).size:0)+Buffer.byteLength(line)>maxLogBytes)throw error('session_history_too_large');
    fs.appendFileSync(log(row.id),line,{mode:0o600});row.cursor=entry.seq;return entry;
  }
  function get(id){if(!idPattern.test(id||'')||!rows.has(id))throw error('session_not_found');return rows.get(id);}
  function visible(row){const {sdkSessionId,createRequestId,createHash,turns,...value}=row;
    return {...value,turns:turns.map(({promptHash,...turn})=>turn),resumable:!!sdkSessionId};
  }
  for(const name of fs.readdirSync(dir).filter(n=>/^[a-f0-9]{32}\.json$/.test(n))){
    safe(path.join(dir,name));const row=read(path.join(dir,name));
    if(row.format!=='starport-session'||row.version!==1||row.id+'.json'!==name||!Array.isArray(row.turns)||!workspaces.includes(row.workspace))throw error('session_registry_invalid');
    const history=events(row);row.cursor=history.length;
    // Recover context IDs; unfinished metadata is conservatively interrupted, never replayed.
    for(const item of history){if(item.type!=='sdk')continue;const event=item.event;
      if(event.type==='system'&&event.subtype==='init'&&uuidPattern.test(event.session_id||''))row.sdkSessionId=event.session_id;
      if(event.type==='result'&&uuidPattern.test(event.session_id||''))row.sdkSessionId=event.session_id;
    }
    if(['running','cancelling'].includes(row.status)){
      row.status='interrupted';const turn=row.turns.at(-1);if(turn){turn.status='interrupted';turn.finishedAt=now();}
      append(row,{type:'state',status:'interrupted',message:'控制端重启，上一轮未自动重发。',turnId:turn?.id});save(row);
    }
    rows.set(row.id,row);
  }
  function requestId(value){if(!uuidPattern.test(value||''))throw error('invalid_request_id');return value;}
  function title(value){if(typeof value!=='string'||!value.trim()||value.length>100)throw error('invalid_session_title');return value.trim();}
  function snapshot(id,after=0){const row=get(id);if(!Number.isSafeInteger(after)||after<0||after>row.cursor)throw error('invalid_event_cursor');
    const page=events(row).slice(after,after+200),nextCursor=page.at(-1)?.seq??after;
    return {session:visible(row),events:page,nextCursor,hasMore:nextCursor<row.cursor};
  }
  function create(input){
    if(!input||!workspaces.includes(input.workspace))throw error('invalid_workspace');
    const rid=requestId(input.requestId),label=title(input.title||'新会话'),hash=digest(JSON.stringify([input.workspace,label]));
    const old=[...rows.values()].find(r=>r.createRequestId===rid);
    if(old){if(old.createHash!==hash)throw error('request_id_conflict');return visible(old);}
    const row={format:'starport-session',version:1,id:crypto.randomBytes(16).toString('hex'),workspace:input.workspace,title:label,
      model,createdAt:now(),updatedAt:now(),status:'idle',archived:false,cursor:0,turns:[],sdkSessionId:null,createRequestId:rid,createHash:hash};
    save(row);rows.set(row.id,row);return visible(row);
  }
  function update(id,input){const row=get(id);if(!input||Object.keys(input).some(k=>!['title','archived'].includes(k)))throw error('invalid_session_update');
    if(input.title!==undefined)row.title=title(input.title);
    if(input.archived!==undefined){if(typeof input.archived!=='boolean')throw error('invalid_session_update');if(live.has(id))throw error('session_busy');row.archived=input.archived;}
    save(row);return visible(row);
  }
  function start(id,input){
    const row=get(id),rid=requestId(input?.requestId),prompt=input?.prompt;
    if(typeof prompt!=='string'||!prompt.trim()||prompt.length>65536||Buffer.byteLength(JSON.stringify(prompt))>120000)throw error('invalid_prompt');
    const hash=digest(prompt),existing=row.turns.find(t=>t.id===rid);
    if(existing){if(existing.promptHash!==hash)throw error('request_id_conflict');return {session:visible(row),turn:visible(row).turns.find(t=>t.id===rid),reused:true};}
    if(closed)throw error('control_stopping');if(row.archived)throw error('session_archived');if(live.has(id))throw error('session_busy');
    if(row.turns.length&&!row.sdkSessionId)throw error('session_context_unconfirmed_create_new');
    authorize(row.workspace);
    if([...live.values()].some(v=>v.workspace===row.workspace)||runtime.status().active.some(v=>v.workspace===row.workspace&&['exec','sdk'].includes(v.operation)))throw error('workspace_busy');
    const turn={id:rid,promptHash:hash,status:'running',startedAt:now()},run={workspace:row.workspace,cancelled:false};
    row.turns.push(turn);row.status='running';live.set(id,run);
    try{append(row,{type:'prompt',prompt,turnId:rid});save(row);}catch(e){live.delete(id);row.turns.pop();row.status='failed';throw e;}
    let pending='',result,streamError;
    function accept(line){if(!line.trim())return;let event;try{event=JSON.parse(line);}catch{throw error('invalid_sdk_event');}
      if(!event||typeof event.type!=='string')throw error('invalid_sdk_event');
      if(['system','result'].includes(event.type)&&uuidPattern.test(event.session_id||'')){
        if(row.sdkSessionId&&row.sdkSessionId!==event.session_id)throw error('session_context_mismatch');row.sdkSessionId=event.session_id;
      }
      append(row,{type:'sdk',event,turnId:rid});if(event.type==='result')result=event;save(row);
    }
    const onOutput=({stream,text})=>{if(stream!=='stdout'||streamError)return;
      try{pending+=text;if(pending.length>8*1024*1024)throw error('sdk_event_too_large');let end;
        while((end=pending.indexOf('\n'))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);accept(line);}
      }catch(e){streamError=e;runtime.cancelSdk(row.workspace).catch(()=>{});}
    };
    let operation;
    try{operation=runtime.execute(row.workspace,{operation:'sdk',request:{prompt,resume:row.sdkSessionId||undefined,model:row.model}},{timeout:300000,onOutput});}
    catch(e){operation=Promise.reject(e);}
    run.done=Promise.resolve(operation).then(out=>{
      if(pending.trim())accept(pending);
      if(streamError)throw streamError;
      if(out.code!==0||!result)throw error('session_turn_interrupted');
      if(result.is_error)throw error('session_turn_failed');
      turn.status='completed';row.status='idle';
    }).catch(e=>{if(run.cancelled&&result&&!result.is_error&&!streamError){turn.status='completed';row.status='idle';return;}
      turn.status=run.cancelled?'cancelled':e.code==='session_turn_interrupted'?'interrupted':'failed';row.status=turn.status;
      turn.error=/^[a-z][a-z0-9_]{1,79}$/.test(e.code||'')?e.code:'session_turn_failed';
    }).finally(()=>{
      if(run.cancelled&&turn.status!=='completed'){turn.status='cancelled';row.status='cancelled';}
      turn.finishedAt=now();if(Number.isFinite(result?.total_cost_usd)){turn.costUsd=result.total_cost_usd;turn.costScope='sdk-session-cumulative-estimate';}
      if(result?.usage)turn.usage=result.usage;
      live.delete(id);
      try{append(row,{type:'state',status:turn.status,turnId:rid,error:turn.error});save(row);}catch{row.status='failed';}
    });
    return {session:visible(row),turn:{...turn,promptHash:undefined},reused:false};
  }
  async function stop(id){const row=get(id),run=live.get(id);if(!run)return visible(row);
    run.cancelled=true;row.status='cancelling';save(row);await runtime.cancelSdk(row.workspace);await run.done;return visible(row);
  }
  return {create,update,start,stop,snapshot,
    list({workspace,archived=false}={}){return [...rows.values()].filter(r=>(!workspace||r.workspace===workspace)&&r.archived===archived).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)).map(visible);},
    close(){closed=true;}
  };
}
