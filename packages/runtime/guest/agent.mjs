import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import * as OpenCC from 'opencc-js';

let input='';for await(const p of process.stdin){input+=p;if(input.length>1024*1024)throw new Error('prompt_too_large');}
const request=JSON.parse(input),connection=JSON.parse(fs.readFileSync('/opt/starport/connection.json','utf8'));
if(typeof request.prompt!=='string'||!request.prompt.trim()||!connection.model)throw new Error('prompt_and_model_required');
const tc=OpenCC.Converter({from:'cn',to:'tw'}),sc=OpenCC.Converter({from:'tw',to:'cn'});
// Preserve fenced code and inline code rather than rewriting executable content.
function prose(value,convert){return value.split(/(```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s]+|(?:[A-Za-z]:\\|\.\/|~\/|\/)[^\s]+)/g).map((x,i)=>i%2?x:convert(x)).join('');}
const env={HOME:'/home/agent',USER:'agent',LOGNAME:'agent',PATH:'/usr/local/bin:/usr/bin:/bin',LANG:'C.UTF-8',TZ:'Asia/Taipei',
  HTTP_PROXY:'http://127.0.0.1:13128',HTTPS_PROXY:'http://127.0.0.1:13128',ALL_PROXY:'http://127.0.0.1:13128',NO_PROXY:'127.0.0.1,localhost',
  ANTHROPIC_BASE_URL:'http://127.0.0.1:18080',ANTHROPIC_API_KEY:connection.capability,
  DISABLE_TELEMETRY:'1',DISABLE_ERROR_REPORTING:'1',CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:'1',CLAUDE_CODE_MAX_OUTPUT_TOKENS:'4096'};
const tools=['Read','Write','Edit','Glob','Grep','Bash','WebFetch','WebSearch'];
const options={cwd:'/workspace',env,model:connection.model,tools,allowedTools:tools,
  permissionMode:'acceptEdits',settingSources:[],persistSession:true,maxTurns:12,maxBudgetUsd:1,
  effort:request.effort||'low',includePartialMessages:true,systemPrompt:{type:'preset',preset:'claude_code',append:'Use English or Traditional Chinese in ordinary responses. Work in /workspace.'}};
if(request.resume){if(!/^[a-f0-9-]{36}$/.test(request.resume))throw new Error('invalid_session_id');options.resume=request.resume;}
const logs='/workspace/.starport-events';fs.mkdirSync(logs,{recursive:true,mode:0o700});
const log=path.join(logs,'events-'+Date.now()+'.jsonl');let sequence=0;
for await(const event of query({prompt:prose(request.prompt,tc),options})){
  const record={sequence:++sequence,event};fs.appendFileSync(log,JSON.stringify(record)+'\n',{mode:0o600});
  const out=structuredClone(record);
  if(out.event.type==='assistant')for(const part of out.event.message?.content||[])if(part.type==='text')part.text=prose(part.text,sc);
  if(out.event.type==='result'&&typeof out.event.result==='string')out.event.result=prose(out.event.result,sc);
  // Partial code fences may span events. Preserve deltas; convert complete messages.
  process.stdout.write(JSON.stringify(out)+'\n');
}
