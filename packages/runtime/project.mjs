import crypto from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {error} from './common.mjs';
import {pipeBridge} from '../control/pipe-bridge.mjs';
import {runtimeBundle} from './project-bundle.mjs';

export function publicIme(value={}){
  if(!value||typeof value!=='object'||Array.isArray(value))value={};
  const phases=['not_started','unavailable','preparing','ready','failed','reconnecting','stopped'];
  return {phase:phases.includes(value.phase)?value.phase:'unavailable',
    mode:['traditional','english','simplified'].includes(value.mode)?value.mode:null,
    defaultChinese:'traditional',available:['traditional','english','simplified'],
    hotkey:['Control+space','Control+Shift+space','Control+Alt+space'].includes(value.hotkey)?value.hotkey:'Control+space',
    rememberWindows:value.rememberWindows!==false,
    error:/^(?:ime|invalid_ime)_[a-z_]{1,80}$/.test(value.error||'')?value.error:null};
}

export function createProjectRuntime(state, { launch, destinations, capabilities, kind="wsl2", installed=()=>false, runtimeDigest, wslg=false, seamless=false, seamlessClipboard="disabled", credentialStorage="keyring", onState=()=>{} } = {}) {
  if(!['keyring','basic'].includes(credentialStorage))throw error('invalid_credential_storage');
  if(!['disabled','text','text-image'].includes(seamlessClipboard))throw error('invalid_clipboard_mode');
  const active=new Map(),nativeStates=new Map(),viewers=new Map();const reports=new Map(),imePending=new Map();let alive=true;
  if(typeof launch!=='function')throw error('workspace_transport_required');
  const spawnRunner=launch;
  function execute(workspace,request,{timeout=120000,onOutput=()=>{}}={}) {
    if(!alive||!/^[a-z][a-z0-9-]{0,47}$/.test(workspace))throw error('invalid_workspace');
    if(request.operation==='native'&&request.display!=='remote'&&request.display!=='seamless'&&!wslg)throw error('wslg_authorization_required');
    if(request.operation==='native'&&request.display==='seamless'&&!seamless)throw error('seamless_authorization_required');
    const key=workspace+':'+request.operation;
    if(active.has(key))throw error('workspace_busy');
    if(['exec','sdk'].includes(request.operation)&&['exec','sdk'].some(op=>active.has(workspace+':'+op)))throw error('workspace_busy');
    const token={...capabilities(workspace)},child=spawnRunner();
    if(request.operation==='native')delete token.modelCapability;
    let stdout='',stderr='',settled=false,bridge;
    const decoders={stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')};
    const done=new Promise((resolve,reject)=>{
      const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);active.delete(key);if(request.operation==='native'){viewers.get(workspace)?.stream.destroy();viewers.delete(workspace);for(const [id,pending] of imePending){if(pending.workspace===workspace){clearTimeout(pending.timer);pending.reject(error('native_session_unavailable'));imePending.delete(id);}}}bridge?.close();onState();err?reject(err):resolve(result);};
      const timer=timeout===null?null:setTimeout(()=>{bridge?.close();child.kill();finish(error('workspace_operation_timeout'));},timeout);
      bridge=pipeBridge(child,destinations,{onChannel:channel=>{
        const viewer=viewers.get(workspace);
        if(channel!=='viewer'||request.operation!=='native'||!['remote','seamless'].includes(request.display)||!viewer||viewer.attached)return;
        viewer.attached=true;clearTimeout(viewer.timer);return viewer.stream;
      },onEvent:f=>{
        if(f.type==='output'){
          if(typeof f.data!=='string'||f.data.length>32768)return finish(error('invalid_runner_output'));
          if(!decoders[f.stream])return finish(error('invalid_runner_stream'));
          const text=decoders[f.stream].write(Buffer.from(f.data,'base64'));
          if(f.stream==='stdout')stdout=(stdout+text).slice(-96*1024*1024);else stderr=(stderr+text).slice(-1024*1024);
          onOutput({stream:f.stream,text});
        }else if(f.type==='exit')finish(null,{code:f.code,stdout,stderr});
        else if(f.type==='failure')finish(error('workspace_runner_failed'));
        else if(f.type==='disconnected')finish(error('workspace_control_disconnected'));
      }});
      active.set(key,{child,bridge,startedAt:new Date().toISOString()});
      child.stdin.write(JSON.stringify({workspace,request:{...request,...token,...(request.operation==='native'?{credentialStorage}:{}),...(request.operation==='native'?{wslg:request.display!=='remote'&&wslg}:{})}})+'\n');
    });
    onState();return done;
  }
  async function nativeAction(workspace,app,display='wslg'){
    if(!['wslg','remote',...(seamless?['seamless']:[])].includes(display))throw error('invalid_display');
    if(display==='wslg'&&!wslg)throw error('wslg_authorization_required');
    if(!['browser','desktop','terminal','login','files','input-test','terminal-input-test','display-compare'].includes(app))throw error('invalid_native_app');
    if(app==='display-compare'&&display!=='wslg')throw error('display_comparison_requires_wslg');
    const id=workspace+':native';
    if(active.has(id)&&nativeStates.get(workspace)?.display!==display)throw error('close_existing_display_first');
    if(!active.has(id)){
      let readyResolve,readyReject,pending='';
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      nativeStates.set(workspace,{phase:'starting',display,apps:{}});
      const timer=setTimeout(()=>{active.get(id)?.bridge.close();readyReject(error('native_start_timeout'));},60000);
      const done=execute(workspace,{operation:'native',display},{timeout:null,onOutput:({stream,text})=>{
        if(stream!=='stdout')return;
        pending+=text;if(pending.length>65536){active.get(id)?.bridge.close();return;}
        let index;while((index=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,index);pending=pending.slice(index+1);
          try{const value=JSON.parse(line);
            if(value.kind==='native_ready'){nativeStates.set(workspace,{phase:'running',display,apps:{},ime:publicIme(value.ime)});clearTimeout(timer);readyResolve();}
            if(value.kind==='native_ime_result'){const p=imePending.get(value.id);if(p&&p.workspace===workspace){clearTimeout(p.timer);imePending.delete(value.id);if(value.error)p.reject(error(/^(?:ime|invalid_ime)_[a-z_]{1,80}$/.test(value.error)?value.error:'ime_action_failed'));else{const result=publicIme(value.ime),state=nativeStates.get(workspace);if(state)state.ime=result;p.resolve(result);}}}
            if(value.kind==='native_state'){const apps=Object.fromEntries(Object.entries(value.apps||{}).filter(([k,v])=>['browser','desktop','terminal','login','files','input-test','terminal-input-test','compare-x11','compare-wayland'].includes(k)&&['running','stopped'].includes(v)));nativeStates.set(workspace,{phase:'running',display,apps,ime:publicIme(value.ime)});}
          }catch{}
        }
      }});
      done.then(result=>{clearTimeout(timer);nativeStates.set(workspace,{phase:result.code===0?'stopped':'failed',apps:{}});readyReject(error('native_session_stopped'));},()=>{clearTimeout(timer);nativeStates.set(workspace,{phase:'stopped',apps:{}});readyReject(error('native_session_stopped'));});
      await ready;
    }
    const session=active.get(id);if(!session)throw error('native_session_unavailable');
    session.bridge.send({type:'native-action',app});return {requested:app,...nativeStates.get(workspace)};
  }
  const digest=runtimeDigest||(()=>runtimeBundle().digest);
  return {execute,reports,nativeAction,digest,
    async imeAction(workspace,action,settings){
      if(!['traditional','english','simplified','restart','settings'].includes(action))throw error('invalid_ime_action');
      if(action==='settings'&&(!settings||Object.keys(settings).sort().join()!=='hotkey,rememberWindows'||!['Control+space','Control+Shift+space','Control+Alt+space'].includes(settings.hotkey)||typeof settings.rememberWindows!=='boolean'))throw error('invalid_ime_settings');
      const session=active.get(workspace+':native');if(!session)throw error('native_session_unavailable');
      if([...imePending.values()].some(p=>p.workspace===workspace))throw error('ime_operation_pending');
      const id=crypto.randomBytes(12).toString('hex');
      return new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>{imePending.delete(id);reject(error('ime_acknowledgement_timeout'));},60000);
        imePending.set(id,{workspace,resolve,reject,timer});
        session.bridge.send({type:'native-action',app:'ime',id,action,...(action==='settings'?{settings}: {})});
      });
    },
    async cancelSdk(workspace){
      const session=active.get(workspace+':sdk');if(!session)return;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(error('session_stop_requires_reconciliation')),12000);
        session.child.once('close',()=>{clearTimeout(timer);resolve();});session.bridge.close();
      });
    },
    attachViewer(workspace,stream,{display='remote'}={}){
      const session=active.get(workspace+':native');
      if(!session||nativeStates.get(workspace)?.display!==display)throw error('remote_display_required');
      if(viewers.has(workspace))throw error('viewer_already_connected');
      const viewer={stream,attached:false,timer:setTimeout(()=>stream.destroy(),10000)};viewers.set(workspace,viewer);
      stream.on('error',()=>stream.destroy());stream.once('close',()=>{clearTimeout(viewer.timer);if(viewers.get(workspace)===viewer)viewers.delete(workspace);});
      session.bridge.send({type:'native-action',app:'viewer'});
    },
    async stopNative(workspace){
      const session=active.get(workspace+':native');if(!session)return;
      await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(error('native_stop_requires_reconciliation')),12000);
        session.child.once('close',()=>{clearTimeout(timer);resolve();});
        session.bridge.close();
      });
    },
    status:()=>({kind,installed:installed(),wslg,seamless,seamlessClipboard,displays:['remote',...(wslg?['wslg']:[]),...(seamless?['seamless']:[])],clipboard:wslg?'shared-with-windows':seamless&&seamlessClipboard==='text-image'?'bidirectional-text-image':seamless&&seamlessClipboard==='text'?'bidirectional-text':'not-shared',native:[...nativeStates].map(([workspace,value])=>({workspace,...value})),active:[...active].map(([key,v])=>({workspace:key.split(':')[0],operation:key.split(':')[1],startedAt:v.startedAt})),reports:[...reports].map(([workspace,receipt])=>({workspace,...receipt,passed:receipt.passed&&receipt.runtimeDigest===digest()&&Date.now()-Date.parse(receipt.checkedAt)<=86400000}))}),
    close(){alive=false;for(const {bridge} of active.values())bridge.close();}
  };
}
