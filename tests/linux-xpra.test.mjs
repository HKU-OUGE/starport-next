import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
const python=spawnSync('python3',['--version']).status===0;
test('Xpra adapter applies options before GUI imports, strips host display metadata, and acknowledges readiness',{skip:!python},()=>{
  const source=fileURLToPath(new URL('../packages/linux/xpra-entry.py',import.meta.url));
  const proof=String.raw`import sys,types,runpy
names=['xpra','xpra.platform','xpra.scripts','xpra.scripts.main','xpra.client','xpra.client.mixins','xpra.client.mixins.display','PIL','PIL.Image']
for name in names:sys.modules[name]=types.ModuleType(name)
for name in names:
 if '.' in name:
  parent,attr=name.rsplit('.',1);setattr(sys.modules[parent],attr,sys.modules[name])
sys.modules['xpra'].__version__='3.1.5'
sys.modules['PIL.Image'].Resampling=types.SimpleNamespace(LANCZOS=1)
p=sys.modules['xpra.platform'];p.init=lambda:None;p.set_default_name=lambda _:None
entry=sys.modules['xpra.scripts.main'];calls=[]
class Client:
 def __init__(self):self._ui_packet_handlers={'startup-complete':self._process_startup_complete}
 def _process_startup_complete(self,packet):calls.append('ready')
def factory(error,opts):
 assert opts['clipboard'] is False;calls.append('factory');return Client()
entry.make_client=factory
def main(*args):
 c=entry.make_client(None,{'clipboard':False});d=sys.modules['xpra.client.mixins.display']
 assert c.get_root_size()==(1920,1080) and d.get_wm_name()=='Starport'
 assert d.get_desktop_names()==('workspace',) and d.get_number_of_desktops()==1
 assert c.get_screen_sizes()[0][0]=='display' and c.get_screen_sizes()[0][5][0][0]=='monitor'
 c._ui_packet_handlers['startup-complete'](None)
 assert calls==['factory','ready'];return 0
entry.main=main
runpy.run_path(sys.argv[1],run_name='__main__')`;
  const r=spawnSync('python3',['-I','-c',proof,source],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);assert.match(r.stdout,/STARPORT_VIEWER_READY/);
});
