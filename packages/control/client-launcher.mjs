import fs from 'node:fs';
import path from 'node:path';

const fail=code=>Object.assign(new Error(code),{code});
export async function launchLocalClient({state,workspace='main',app,fetcher=fetch,display}){
  if(!['browser','desktop','terminal','login'].includes(app))throw fail('invalid_native_app');
  if(!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw fail('invalid_workspace');
  let record,key;
  try{
    record=JSON.parse(fs.readFileSync(path.join(state,'control.json'),'utf8'));
    key=JSON.parse(fs.readFileSync(path.join(state,'panel-key.json'),'utf8')).key;
  }catch{throw fail('control_not_running');}
  if(record.phase!=='running'||!Number.isInteger(record.port)||record.port<1024||record.port>65535)throw fail('control_not_running');
  if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw fail('invalid_panel_key');
  // Never accept a hostname from a receipt, follow redirects or pass secrets to WSL.
  const origin='http://127.0.0.1:'+record.port;let cookie='',csrf='';
  async function request(route,body){
    let response;
    try{response=await fetcher(origin+route,{method:body===undefined?'GET':'POST',redirect:'error',
      headers:{origin,...(cookie?{cookie}:{}),...(body===undefined?{}:{'content-type':'application/json','x-csrf-token':csrf})},
      body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(150000)});}
    catch{throw fail(body===undefined||route==='/api/login'?'control_unreachable':'launch_outcome_unknown');}
    let value;try{value=await response.json();}catch{throw fail('invalid_control_response');}
    if(!response.ok)throw fail(/^[a-z_]{1,100}$/.test(value.error)?value.error:'client_launch_failed');
    return {value,response};
  }
  const login=await request('/api/login',{key});key=undefined;
  cookie=login.response.headers.get('set-cookie')?.split(';')[0]||'';
  if(!/^starport_control=[a-f0-9]+$/.test(cookie))throw fail('invalid_control_session');
  let status=(await request('/api/status')).value;csrf=status.csrf;
  display ||= status.runtime?.seamless?'seamless':'wslg';
  if(!['wslg','seamless'].includes(display)||!status.runtime?.[display])throw fail(display==='wslg'?'wslg_authorization_required':'seamless_authorization_required');
  if(!status.workspaces?.includes(workspace))throw fail('unknown_workspace');
  const session=status.runtime.native?.find(v=>v.workspace===workspace&&['starting','running'].includes(v.phase));
  if(session&&session.display!==display)throw fail('close_existing_display_first');
  if(!status.egress?.enabled)throw fail('enable_controlled_egress_first');
  if(!status.runtime.reports?.some(v=>v.workspace===workspace&&v.passed)){
    if(status.runtime.active?.length)throw fail('workspace_verification_required');
    const verified=(await request(`/api/workspaces/${workspace}/verify`,{})).value;
    if(!verified.passed)throw fail('workspace_verification_failed');
  }
  await request(`/api/workspaces/${workspace}/native`,{app,display});
  // Acknowledgement means requested, not that the app remained running.
  let runningSamples=0;
  for(let attempt=0;attempt<28;attempt++){
    status=(await request('/api/status')).value;
    const native=status.runtime.native?.find(v=>v.workspace===workspace);
    if(native?.phase==='running'&&native.apps?.[app]==='running'){
      if(++runningSamples>=10)return {workspace,app,display,phase:'running'};
    }else runningSamples=0;
    if(native?.phase==='failed'||native?.apps?.[app]==='stopped')throw fail('native_app_stopped');
    await new Promise(resolve=>setTimeout(resolve,250));
  }
  throw fail('launch_outcome_unknown');
}
