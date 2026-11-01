import fs from 'node:fs';
import {query} from '/usr/local/lib/starport/agent/node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs';
import {createRequire} from 'node:module';
const require=createRequire('/usr/local/lib/starport/agent/package.json'),OpenCC=require('opencc-js');
const tc=OpenCC.Converter({from:'cn',to:'tw'}),sc=OpenCC.Converter({from:'tw',to:'cn'});
function prose(value,convert){return value.split(/(```[\s\S]*?```|`[^`\n]+`|https?:\/\/[^\s]+|(?:[A-Za-z]:\\|\.\/|~\/|\/)[^\s]+)/g).map((x,i)=>i%2?x:convert(x)).join('');}
let input='';for await(const b of process.stdin){input+=b;if(input.length>131072)throw Error('prompt_too_large');}
const request=JSON.parse(input);
if(typeof request.prompt!=='string'||!request.prompt.trim()||typeof request.model!=='string'||!process.env.ANTHROPIC_API_KEY)throw Error('sdk_request_invalid');
const env={...process.env,CLAUDE_CONFIG_DIR:'/home/agent/.claude-sdk'};
delete env.CLAUDE_CODE_OAUTH_TOKEN;delete env.ANTHROPIC_AUTH_TOKEN;
const options={cwd:'/workspace',env,model:request.model,tools:['Read','Write','Edit','Glob','Grep','Bash'],
  allowedTools:['Read','Write','Edit','Glob','Grep','Bash','mcp__starport-compute__*'],permissionMode:'acceptEdits',settingSources:[],
  mcpServers:{'starport-compute':{command:'/usr/bin/python3',args:['-I','/opt/starport/compute-mcp.py'],
    env:{STARPORT_COMPUTE_URL:process.env.STARPORT_COMPUTE_URL,STARPORT_COMPUTE_TOKEN:process.env.STARPORT_COMPUTE_TOKEN}}},
  strictMcpConfig:true,
  systemPrompt:{type:'preset',preset:'claude_code',append:fs.readFileSync('/opt/starport/COMPUTE-AGENT.md','utf8')},
  persistSession:true,maxTurns:8,effort:'low',includePartialMessages:false};
if(request.resume){if(!/^[a-f0-9-]{36}$/.test(request.resume))throw Error('invalid_session_id');options.resume=request.resume;}
const logs='/workspace/.starport-events';fs.mkdirSync(logs,{recursive:true,mode:0o700});
const log=logs+'/wsl-sdk-'+Date.now()+'.jsonl';
for await(const event of query({prompt:prose(request.prompt,tc),options})){
  fs.appendFileSync(log,JSON.stringify(event)+'\n',{mode:0o600});
  const displayed=structuredClone(event);
  if(displayed.type==='assistant')for(const part of displayed.message?.content||[])if(part.type==='text')part.text=prose(part.text,sc);
  if(displayed.type==='result'&&typeof displayed.result==='string')displayed.result=prose(displayed.result,sc);
  process.stdout.write(JSON.stringify(displayed)+'\n');
}
