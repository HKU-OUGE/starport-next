import {control} from './control.mjs';
import {projectReceipt,spawnProjectSsh} from './qemu-project.mjs';
const state=process.argv[2];let child;
try{
  const receipt=projectReceipt(state),status=await control(state);
  if(!status.ready||status.vmId!==receipt.vmId)throw Error('workspace_not_ready');
  child=spawnProjectSsh(state,status,receipt);
  child.stdin.on('error',()=>{process.stdin.unpipe(child.stdin);process.stdin.destroy();});
  process.stdin.pipe(child.stdin);child.stdout.pipe(process.stdout);child.stderr.pipe(process.stderr);
  child.on('error',()=>{process.exitCode=1;process.stdin.destroy();});
  child.on('exit',code=>{process.exitCode=code??1;process.stdin.destroy();});
  process.on('SIGTERM',()=>child.kill());process.on('SIGINT',()=>child.kill());
}catch{process.stderr.write('project_transport_unavailable\n');process.exitCode=1;}
