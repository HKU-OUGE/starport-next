import {launchLocalClient} from '../packages/control/client-launcher.mjs';
try{
  const args=process.argv.slice(2),options={};
  for(let i=0;i<args.length;i+=2){
    if(!['--state','--workspace','--app','--display'].includes(args[i])||!args[i+1])throw Error('invalid_arguments');
    options[args[i].slice(2)]=args[i+1];
  }
  if(!options.state)throw Error('control_state_required');
  console.log(JSON.stringify({ok:true,...await launchLocalClient(options)}));
}catch(error){
  console.log(JSON.stringify({ok:false,error:/^[a-z_]{1,100}$/.test(error.message)?error.message:'client_launch_failed'}));
  process.exitCode=1;
}
