import {StringDecoder} from 'node:string_decoder';
import {error} from './common.mjs';
import {pipeBridge} from '../control/pipe-bridge.mjs';
import {runtimeBundle} from './project-bundle.mjs';

export function createProjectRuntime(state, { launch, destinations, capabilities, kind="wsl2", installed=()=>false, runtimeDigest, wslg=false, seamless=false, onState=()=>{} } = {}) {
  const active=new Map(),nativeStates=new Map(),viewers=new Map();const reports=new Map();let alive=true;
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
      const finish=(err,result)=>{if(settled)return;settled=true;clearTimeout(timer);active.delete(key);if(request.operation==='native'){viewers.get(workspace)?.stream.destroy();viewers.delete(workspace);}bridge?.close();onState();err?reject(err):resolve(result);};
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
      child.stdin.write(JSON.stringify({workspace,request:{...request,...token,...(request.operation==='native'?{wslg:request.display!=='remote'&&wslg}:{})}})+'\n');
    });
    onState();return done;
  }
  async function nativeAction(workspace,app,display='wslg'){
    if(!['wslg','remote',...(seamless?['seamless']:[])].includes(display))throw error('invalid_display');
    if(display==='wslg'&&!wslg)throw error('wslg_authorization_required');
    if(!['browser','desktop','terminal','login'].includes(app))throw error('invalid_native_app');
    const id=workspace+':native';
    if(active.has(id)&&nativeStates.get(workspace)?.display!==display)throw error('close_existing_display_first');
    if(!active.has(id)){
      let readyResolve,readyReject,pending='';
      const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});
      nativeStates.set(workspace,{phase:'starting',display,apps:{}});
      const timer=setTimeout(()=>{active.get(id)?.bridge.close();readyReject(error('native_start_timeout'));},20000);
      const done=execute(workspace,{operation:'native',display},{timeout:null,onOutput:({stream,text})=>{
        if(stream!=='stdout')return;
        pending+=text;if(pending.length>65536){active.get(id)?.bridge.close();return;}
        let index;while((index=pending.indexOf('\n'))>=0){
          const line=pending.slice(0,index);pending=pending.slice(index+1);
          try{const value=JSON.parse(line);
            if(value.kind==='native_ready'){nativeStates.set(workspace,{phase:'running',display,apps:{}});clearTimeout(timer);readyResolve();}
            if(value.kind==='native_state'){const apps=Object.fromEntries(Object.entries(value.apps||{}).filter(([k,v])=>['browser','desktop','terminal','login'].includes(k)&&['running','stopped'].includes(v)));nativeStates.set(workspace,{phase:'running',display,apps});}
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
    status:()=>({kind,installed:installed(),wslg,seamless,displays:['remote',...(wslg?['wslg']:[]),...(seamless?['seamless']:[])],clipboard:wslg?'shared-with-windows':'not-shared',native:[...nativeStates].map(([workspace,value])=>({workspace,...value})),active:[...active].map(([key,v])=>({workspace:key.split(':')[0],operation:key.split(':')[1],startedAt:v.startedAt})),reports:[...reports].map(([workspace,receipt])=>({workspace,...receipt,passed:receipt.passed&&receipt.runtimeDigest===digest()&&Date.now()-Date.parse(receipt.checkedAt)<=86400000}))}),
    close(){alive=false;for(const {bridge} of active.values())bridge.close();}
  };
}
