import test from 'node:test';
import assert from 'node:assert/strict';
import {initIme} from '../packages/control/web/ime.js';

test('an IME acknowledgement from a previous project cannot overwrite the selected project',async()=>{
  const elements=new Map(),actions=new Map();
  const element=id=>{if(!elements.has(id))elements.set(id,{id,value:'',textContent:'',checked:true,open:false,addEventListener(){}});return elements.get(id);};
  const prior=globalThis.document;globalThis.document={getElementById:element,activeElement:null};
  let project='first',resolveRequest;const calls=[];
  try{
    const controller=initIme({workspace:()=>project,action:(button,fn)=>actions.set(button.id,fn),api:(route)=>{calls.push(route);return new Promise(resolve=>resolveRequest=resolve);}});
    const status={runtime:{native:[{workspace:'first',phase:'running',ime:{phase:'ready',mode:'traditional'}},{workspace:'second',phase:'running',ime:{phase:'ready',mode:'english'}}]}};
    controller.update(status);const request=actions.get('ime-restart')();
    project='second';controller.update(status);resolveRequest({phase:'ready',mode:'simplified'});await request;
    assert.deepEqual(calls,['/api/workspaces/first/ime']);
    assert.equal(status.runtime.native[1].ime.mode,'english');assert.equal(element('ime-message').textContent,'');assert.equal(element('ime-mode').value,'english');
  }finally{globalThis.document=prior;}
});
