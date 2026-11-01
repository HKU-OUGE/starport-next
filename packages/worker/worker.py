# Derived from Starport Pi (MIT), Copyright (c) 2026 Starport contributors.
# Maintained here as the standalone Starport Next worker. See THIRD_PARTY.md.
"""SSH RPC control plane. Model commands execute only in the pinned runsc sandbox."""
import base64
import contextlib
import errno
import fcntl
import hashlib
import json
import os
import pathlib
import re
import shutil
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid

ROOT=pathlib.Path(__file__).resolve().parent
LIMIT=8*1024*1024
FINAL={'completed','failed','cancelled'}


def digest(path):
    h=hashlib.sha256()
    with open(path,'rb') as f:
        for b in iter(lambda:f.read(1024*1024),b''):h.update(b)
    return h.hexdigest()


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_size>LIMIT:raise ValueError('invalid_record')
    return json.loads(path.read_text())


def save(path,value):
    path.parent.mkdir(parents=True,exist_ok=True,mode=0o700)
    temporary=path.with_name(path.name+'.'+uuid.uuid4().hex+'.next')
    with temporary.open('x') as f:
        os.chmod(temporary,0o600);json.dump(value,f);f.flush();os.fsync(f.fileno())
    temporary.replace(path)


def identity(value):
    if not isinstance(value,str) or not re.fullmatch('[a-f0-9]{32}',value):raise ValueError('invalid_id')
    return value


def relative(value):
    if not isinstance(value,str) or len(value)>1024 or '\\' in value or '\x00' in value or ':' in value:raise ValueError('invalid_path')
    p=pathlib.PurePosixPath(value)
    if p.is_absolute() or any(x in ('','.', '..') for x in value.split('/')):raise ValueError('invalid_path')
    return p.parts


@contextlib.contextmanager
def directory(root,parts=(),create=False):
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts:
            if create:
                try:
                    os.mkdir(part,0o777,dir_fd=fd)
                    os.chmod(part,0o777,dir_fd=fd,follow_symlinks=False)
                except FileExistsError:pass
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
        yield fd
    finally:os.close(fd)


def open_file(root,name,write=False):
    parts=relative(name)
    with directory(root,parts[:-1],create=write) as fd:
        flags=(os.O_WRONLY|os.O_CREAT|os.O_TRUNC if write else os.O_RDONLY)|os.O_NOFOLLOW|os.O_NONBLOCK
        result=os.open(parts[-1],flags,0o644,dir_fd=fd)
        if not stat.S_ISREG(os.fstat(result).st_mode):os.close(result);raise ValueError('regular_file_required')
        return result


def write_file(root,name,data):
    parts=relative(name)
    with directory(root,parts[:-1],create=True) as fd:
        temporary='.starport-'+uuid.uuid4().hex
        handle=os.open(temporary,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=fd)
        try:
            with os.fdopen(handle,'wb') as f:
                f.write(data);f.flush();os.fsync(f.fileno());os.fchmod(f.fileno(),0o666)
                if os.stat(temporary,dir_fd=fd,follow_symlinks=False).st_ino!=os.fstat(f.fileno()).st_ino:raise ValueError('workspace_changed')
            os.replace(temporary,parts[-1],src_dir_fd=fd,dst_dir_fd=fd)
        finally:
            with contextlib.suppress(FileNotFoundError):os.unlink(temporary,dir_fd=fd)


def walk_files(fd,prefix=()):
    """Never re-resolve a path through a directory the task can replace."""
    for name in sorted(os.listdir(fd)):
        st=os.stat(name,dir_fd=fd,follow_symlinks=False)
        if stat.S_ISDIR(st.st_mode):
            child=os.open(name,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            try:yield from walk_files(child,(*prefix,name))
            finally:os.close(child)
        elif stat.S_ISREG(st.st_mode):
            child=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
            try:
                if not stat.S_ISREG(os.fstat(child).st_mode):raise ValueError('regular_file_required')
                yield (*prefix,name),child
            finally:os.close(child)
        else:raise ValueError('linked_or_special_file_rejected')


@contextlib.contextmanager
def lock(config):
    with (pathlib.Path(config['state'])/'scheduler.lock').open('a') as f:
        fcntl.flock(f,fcntl.LOCK_EX);yield


def configuration():
    cfg=read_json(ROOT/'config.json')
    if cfg.get('format')!=1:raise ValueError('unsupported_server_configuration')
    egress=pathlib.Path(cfg['egress_socket'])
    if not re.fullmatch(r'/tmp/starport-egress-[a-f0-9]{32}/proxy\.sock',str(egress)):raise ValueError('invalid_egress_configuration')
    egress.parent.mkdir(mode=0o700,exist_ok=True)
    if egress.parent.is_symlink():raise ValueError('invalid_egress_configuration')
    return cfg


def workspace(cfg,wid):
    p=pathlib.Path(cfg['state'])/'workspaces'/identity(wid)
    if p.is_symlink() or not p.is_dir():raise ValueError('workspace_not_found')
    return p


def job(cfg,jid,wid=None):
    p=pathlib.Path(cfg['state'])/'jobs'/identity(jid)
    d=read_json(p/'status.json')
    if wid is not None and d['workspace']!=wid:raise ValueError('job_not_found')
    return p,d


def public_status(value):
    allowed=('id','workspace','status','created_at','started_at','ended_at','exit_code','error','cpus','memory_gib','gpus','released','log_start','log_end')
    return {k:value[k] for k in allowed if k in value}


def records(cfg):
    return [(p,read_json(p/'status.json')) for p in (pathlib.Path(cfg['state'])/'jobs').iterdir() if re.fullmatch('[a-f0-9]{32}',p.name) and not p.is_symlink() and (p/'status.json').exists()]


def process_stamp(pid):
    try:
        fields=(pathlib.Path('/proc')/str(pid)/'stat').read_text().rsplit(')',1)[1].split()
        return None if fields[0]=='Z' else fields[19]
    except (OSError,IndexError):return None


def reconcile(cfg):
    """A lost controller is distinct from a silent program or a closed client."""
    with lock(cfg):
        for p,state in records(cfg):
            if state.get('released') or time.time()-state['created_at']<10:continue
            stamp=process_stamp(state.get('controller_pid',0))
            if stamp and stamp==state.get('controller_stamp'):continue
            if cleanup(cfg,p):
                state.update(status='failed',error='controller_interrupted',released=True,ended_at=time.time())
                save(p/'status.json',state)


def runsc(cfg,p):
    return [cfg['runsc'],'--root='+str(p/'runtime'),'--rootless','--ignore-cgroups','--network=none','--overlay2=none','--host-uds=open','--platform='+cfg.get('platform','systrap')]


def system_env(cfg):
    profile=read_json(ROOT/'region.json')
    env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':'/workspace','USER':'worker','LOGNAME':'worker',
         'HTTP_PROXY':'http://127.0.0.1:18080','HTTPS_PROXY':'http://127.0.0.1:18080',
         'http_proxy':'http://127.0.0.1:18080','https_proxy':'http://127.0.0.1:18080',
         'NO_PROXY':'localhost,127.0.0.1','no_proxy':'localhost,127.0.0.1',**profile['environment']}
    return [k+'='+v for k,v in env.items()]


def gpu_free(cfg):
    allowed=cfg.get('gpu_indices',[])
    if not allowed:return []
    try:
        rows=subprocess.check_output(['nvidia-smi','--query-gpu=index,memory.used','--format=csv,noheader,nounits'],text=True,timeout=10).splitlines()
        return [int(r.split(',')[0]) for r in rows if int(r.split(',')[0]) in allowed and int(r.split(',')[1])<256]
    except (OSError,ValueError,subprocess.SubprocessError):raise ValueError('gpu_availability_unverified') from None


def memory_capacity_bytes():
    """Physical/cgroup capacity is independent of the operator's policy ceiling."""
    total=int(next(l.split()[1] for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemTotal:')))*1024
    for name in ['/sys/fs/cgroup/memory.max','/sys/fs/cgroup/memory/memory.limit_in_bytes']:
        try:
            value=pathlib.Path(name).read_text().strip()
            if value.isdigit():total=min(total,int(value))
        except OSError:pass
    return total


def submit(cfg,request):
    wid=request['workspace'];workspace(cfg,wid)
    command=request.get('command')
    if not isinstance(command,str) or not 1<=len(command)<=131072 or '\x00' in command:raise ValueError('invalid_command')
    values={k:request.get(k,default) for k,default in [('cpus',2),('memory_gib',4),('gpus',0),('timeout',600)]}
    if any(type(v) is not int or v<0 for v in values.values()) or not 1<=values['timeout']<=86400 or values['cpus']<1 or values['memory_gib']<1:raise ValueError('invalid_resources')
    datasets=request.get('datasets',[])
    if not isinstance(datasets,list) or len(datasets)>16:raise ValueError('invalid_datasets')
    for did in datasets:
        folder=pathlib.Path(cfg['state'])/'datasets'/identity(did)
        if folder.is_symlink() or not (folder/'manifest.json').is_file():raise ValueError('dataset_not_found')
    with lock(cfg):
        active=[r for _,r in records(cfg) if not r.get('released')]
        if any(r['workspace']==wid for r in active):raise ValueError('workspace_busy')
        parallel=cfg.get('max_parallel',4)
        if parallel is not None and len(active)>=parallel:raise ValueError('task_capacity')
        used={c for r in active for c in r['cpu_indices']}
        free=[c for c in cfg['cpu_indices'] if c not in used]
        if len(free)<values['cpus']:raise ValueError('cpu_capacity')
        reserved=sum(r['memory_gib'] for r in active)
        avail=int(next(l.split()[1] for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:')))*1024
        capacity=min(cfg['memory_gib']*1024**3,memory_capacity_bytes())
        if (reserved+values['memory_gib'])*1024**3>capacity or values['memory_gib']*1024**3>avail:raise ValueError('memory_capacity')
        gpu=[]
        if values['gpus']:
            if not cfg.get('driver_files'):raise ValueError('gpu_driver_view_not_configured')
            busy={g for r in active for g in r['gpu_indices']};gpu=[g for g in gpu_free(cfg) if g not in busy]
            if len(gpu)<values['gpus']:raise ValueError('gpu_capacity')
        jid=uuid.uuid4().hex;p=pathlib.Path(cfg['state'])/'jobs'/jid;p.mkdir(mode=0o700)
        state={'id':jid,'workspace':wid,'status':'queued','created_at':time.time(),**values,
            'cpu_indices':free[:values['cpus']],'gpu_indices':gpu[:values['gpus']],'released':False,'log_start':0,'log_end':0}
        save(p/'request.json',{'command':command,'datasets':datasets});save(p/'status.json',state)
        proc=subprocess.Popen([sys.executable,'-I',str(ROOT/'worker.py'),'run',jid],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,start_new_session=True,env={'PATH':'/usr/bin:/bin'})
        state['controller_pid']=proc.pid;state['controller_stamp']=process_stamp(proc.pid);save(p/'status.json',state)
        return public_status(state)


def specification(cfg,p,state):
    request=read_json(p/'request.json');bundle=p/'bundle';bundle.mkdir();out=p/'output';out.mkdir(mode=0o777);out.chmod(0o777)
    root=pathlib.Path(cfg['rootfs'])
    if root.is_symlink() or digest(root/'opt/starport/region.json')!=cfg['region_sha256']:raise ValueError('rootfs_profile_changed')
    if digest(cfg['runsc'])!=cfg['runsc_sha256']:raise ValueError('runtime_integrity_failed')
    for name,expected in cfg.get('runtime_files',{}).items():
        if digest(ROOT/name)!=expected:raise ValueError('runtime_integrity_failed')
    def bind(source,destination,readonly=True):return {'destination':destination,'type':'bind','source':str(source),'options':['bind','nosuid','nodev',*(['ro'] if readonly else [])]}
    mounts=[{'destination':'/proc','type':'proc','source':'proc'},
        {'destination':'/dev','type':'tmpfs','source':'tmpfs','options':['nosuid','mode=755']},
        {'destination':'/dev/shm','type':'tmpfs','source':'tmpfs','options':['nosuid','nodev','size=268435456','mode=1777']},
        {'destination':'/tmp','type':'tmpfs','source':'tmpfs','options':['nosuid','nodev','size=1073741824','mode=1777']},
        bind(workspace(cfg,state['workspace']),'/workspace',False),bind(out,'/output',False)]
    empty=p/'empty';empty.write_bytes(b'')
    mounts.extend([bind(empty,'/etc/machine-id'),bind(empty,'/proc/sys/kernel/random/boot_id')])
    if pathlib.Path(cfg['egress_socket']).exists():
        if not stat.S_ISSOCK(os.stat(cfg['egress_socket']).st_mode):raise ValueError('egress_socket_invalid')
        mounts.append(bind(cfg['egress_socket'],'/run/starport/egress.sock'))
    for did in request['datasets']:
        mounts.append(bind(pathlib.Path(cfg['state'])/'datasets'/did/'payload','/data/shared/'+did))
    devices=[]
    if state['gpus']:
        for row in cfg['driver_files']:
            if digest(row['source'])!=row['sha256']:raise ValueError('gpu_driver_changed')
            mounts.append(bind(row['source'],row['destination']))
        for name in ['nvidiactl','nvidia-uvm']+['nvidia'+str(g) for g in state['gpu_indices']]:
            st=os.stat('/dev/'+name);devices.append({'path':'/dev/'+name,'type':'c','major':os.major(st.st_rdev),'minor':os.minor(st.st_rdev),'fileMode':0o666,'uid':0,'gid':0})
    env=system_env(cfg)+['OMP_NUM_THREADS='+str(state['cpus']),'NVIDIA_VISIBLE_DEVICES='+','.join(map(str,state['gpu_indices'])),'NVIDIA_DRIVER_CAPABILITIES=compute,utility']
    if state['gpus']:env+=['LD_LIBRARY_PATH=/opt/starport-driver']
    spec={'ociVersion':'1.0.2','root':{'path':str(root),'readonly':True},'hostname':'workspace',
        # Single-ID rootless mappings require guest UID 0 for persistent bind writes.
        # Guest root has no capabilities; the host account and filesystem stay outside gVisor.
        'process':{'terminal':False,'user':{'uid':0,'gid':0},'args':['/usr/local/bin/python3','/opt/starport/guest_entry.py',str(state['timeout']),'/bin/bash','-lc',request['command']],
            'env':env,'cwd':'/workspace','noNewPrivileges':True,'capabilities':{k:[] for k in ['bounding','effective','inheritable','permitted','ambient']},
            'rlimits':[{'type':'RLIMIT_CORE','soft':0,'hard':0},{'type':'RLIMIT_NOFILE','soft':1024,'hard':1024}]},
        'mounts':mounts,'linux':{'namespaces':[{'type':v} for v in ['user','pid','network','ipc','uts','mount']],
            'uidMappings':[{'containerID':0,'hostID':os.getuid(),'size':1}],
            'gidMappings':[{'containerID':0,'hostID':os.getgid(),'size':1}],'devices':devices}}
    save(bundle/'config.json',spec)
    return bundle


def process_rss(pid):
    seen=set();todo=[pid];total=0
    while todo:
        value=todo.pop()
        if value in seen:continue
        seen.add(value)
        try:
            p=pathlib.Path('/proc')/str(value)
            total+=int((p/'statm').read_text().split()[1])*os.sysconf('SC_PAGE_SIZE')
            todo.extend(map(int,(p/'task'/str(value)/'children').read_text().split()))
        except (OSError,ValueError,IndexError):pass
    return total


def cleanup(cfg,p):
    command=runsc(cfg,p)
    try:
        subprocess.run(command+['delete','--force','task'],capture_output=True,timeout=15)
        result=subprocess.run(command+['list','--format=json'],capture_output=True,text=True,timeout=15,check=True)
        return not json.loads(result.stdout)
    except (OSError,ValueError,subprocess.SubprocessError):return False


def run_job(cfg,jid):
    # Serialize startup against submit's PID receipt.
    with lock(cfg):p,state=job(cfg,jid)
    proc=None;error=None;cancelled=False;code=None
    try:
        os.sched_setaffinity(0,set(state['cpu_indices']))
        bundle=specification(cfg,p,state)
        logfile=p/'stdout.log';logfile.touch(mode=0o600)
        with logfile.open('ab',buffering=0) as log:
            cmd=runsc(cfg,p)
            if state['gpus']:cmd+=['--nvproxy']
            proc=subprocess.Popen(cmd+['run','--bundle='+str(bundle),'task'],stdin=subprocess.DEVNULL,stdout=log,stderr=log,start_new_session=True,env={'PATH':'/usr/local/bin:/usr/bin:/bin','HOME':str(p)})
            state.update(status='running',started_at=time.time());save(p/'status.json',state)
            while proc.poll() is None:
                if (p/'cancel').exists():cancelled=True;error='task_cancelled';break
                if time.time()-state['started_at']>state['timeout']:error='task_timeout';break
                if process_rss(proc.pid)>state['memory_gib']*1024**3:error='task_memory_limit';break
                # Log volume never fails computation. Keep a bounded recent tail.
                size=logfile.stat().st_size
                if size>16*1024*1024:
                    with logfile.open('r+b') as f:
                        f.seek(-8*1024*1024,os.SEEK_END);tail=f.read();f.seek(0);f.write(tail);f.truncate()
                    state['log_start']+=size-len(tail)
                state['log_end']=state['log_start']+logfile.stat().st_size;save(p/'status.json',state)
                time.sleep(.5)
            if error:
                subprocess.run(runsc(cfg,p)+['kill','--all','task','KILL'],capture_output=True,timeout=10)
            try:code=proc.wait(timeout=15)
            except subprocess.TimeoutExpired:proc.kill();code=proc.wait(timeout=5)
            if not error and code: error='command_failed'
    except Exception as exc:
        error=str(exc) if isinstance(exc,ValueError) and re.fullmatch('[a-z0-9_]{1,80}',str(exc)) else 'sandbox_start_failed'
    finally:
        released=cleanup(cfg,p)
        if not released:error='resource_cleanup_unconfirmed'
        state.update(status='cancelled' if cancelled else 'failed' if error else 'completed',error=error,exit_code=code,ended_at=time.time(),released=released)
        if (p/'stdout.log').exists():state['log_end']=state['log_start']+(p/'stdout.log').stat().st_size
        save(p/'status.json',state)


def publish(cfg,wid,name):
    source=workspace(cfg,wid);parts=relative(name)
    did=uuid.uuid4().hex;folder=pathlib.Path(cfg['state'])/'datasets'/did;payload=folder/'payload';payload.mkdir(parents=True,mode=0o700)
    rows=[];total=0
    try:
        with directory(source,parts) as top:
            for components,fd in walk_files(top):
                rel='/'.join(components)
                with os.fdopen(os.dup(fd),'rb') as inp:
                    before=os.fstat(inp.fileno());total+=before.st_size
                    if len(rows)>=10000 or total>cfg.get('dataset_max_bytes',100*1024**3):raise ValueError('dataset_capacity')
                    target=payload/rel;target.parent.mkdir(parents=True,exist_ok=True)
                    h=hashlib.sha256()
                    copied=0
                    with target.open('xb') as out:
                        for b in iter(lambda:inp.read(1024*1024),b''):
                            copied+=len(b)
                            if copied>before.st_size:raise ValueError('dataset_changed')
                            h.update(b);out.write(b)
                    after=os.fstat(inp.fileno())
                    if copied!=before.st_size or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('dataset_changed')
                    target.chmod(0o444);rows.append({'path':rel,'bytes':after.st_size,'sha256':h.hexdigest()})
        payload.chmod(0o755)
        save(folder/'manifest.json',{'id':did,'files':rows,'bytes':total,'created_at':time.time()})
        return {'id':did,'files':len(rows),'bytes':total,'path':'/data/shared/'+did,'readonly':True}
    except BaseException:shutil.rmtree(folder);raise


def dispatch(cfg,r):
    op=r.get('operation')
    schemas={'health':set(),'egress.reset':set(),'workspace.create':set(),'file.read':{'path','offset','size'},'file.write':{'path','content'},
        'file.list':{'path'},'job.submit':{'command','cpus','memory_gib','gpus','timeout','datasets'},
        'job.status':{'job'},'job.logs':{'job','cursor'},'job.cancel':{'job'},'job.artifacts':{'job'},
        'artifact.read':{'job','path','offset','size','version'},'dataset.publish':{'path'},'dataset.list':set(),
        'upload.begin':{'path','bytes','sha256'},'upload.chunk':{'upload','offset','data','sha256'},'upload.finish':{'upload'}}
    if op not in schemas or set(r)-schemas[op]-{'operation','workspace'}:raise ValueError('unsupported_operation')
    if op=='egress.reset':
        # Trusted operator RPC only. A workload never receives the management key.
        with lock(cfg):
            if any(not row.get('released') for _,row in records(cfg)):raise ValueError('wait_for_worker_jobs')
            p=pathlib.Path(cfg['egress_socket'])
            if not p.exists():return {'removed':False}
            st=p.lstat()
            if not stat.S_ISSOCK(st.st_mode) or st.st_uid!=os.getuid():raise ValueError('egress_ownership_mismatch')
            with socket.socket(socket.AF_UNIX) as s:
                s.settimeout(1)
                try:s.connect(str(p))
                except OSError as exc:
                    if exc.errno!=errno.ECONNREFUSED:raise ValueError('egress_state_unknown') from None
                else:raise ValueError('egress_already_owned')
            current=p.lstat()
            if (current.st_ino,current.st_dev)!=(st.st_ino,st.st_dev):raise ValueError('egress_changed')
            p.unlink();return {'removed':True}
    if op=='health':
        reconcile(cfg)
        ready=False;s=socket.socket(socket.AF_UNIX);s.settimeout(1)
        try:s.connect(cfg['egress_socket']);ready=True
        except OSError:pass
        finally:s.close()
        return {'ready':True,'region':'taiwan-utf8-v1','egress_socket':cfg['egress_socket'],'egress_ready':ready,
            'cpus':len(set(cfg['cpu_indices'])&set(os.sched_getaffinity(0))),'memory_gib':min(cfg['memory_gib'],memory_capacity_bytes()//1024**3),'gpus':len(cfg.get('gpu_indices',[]))}
    if op=='workspace.create':
        wid=uuid.uuid4().hex;p=pathlib.Path(cfg['state'])/'workspaces'/wid;p.mkdir(mode=0o777);p.chmod(0o777)
        return {'id':wid,'path':'/workspace'}
    wid=identity(r.get('workspace'));ws=workspace(cfg,wid)
    if op=='job.submit':reconcile(cfg);return submit(cfg,r)
    if op.startswith('job.') or op=='artifact.read':
        if op=='job.status':reconcile(cfg)
        p,state=job(cfg,r.get('job'),wid)
        if op=='job.status':return public_status(state)
        if op=='job.cancel':(p/'cancel').touch();return {'id':state['id'],'cancel_requested':True}
        if op=='job.logs':
            cursor=r.get('cursor',0)
            if type(cursor) is not int or cursor<0:raise ValueError('invalid_cursor')
            log=p/'stdout.log';start=state.get('log_start',0)
            with log.open('rb') if log.exists() else contextlib.nullcontext(None) as f:
                if f:f.seek(max(0,cursor-start));data=f.read(256*1024)
                else:data=b''
            text=data.decode('utf-8','replace')
            for value in sorted({str(ROOT),str(cfg['state']),str(cfg['rootfs']),str(cfg['runsc'])},key=len,reverse=True):text=text.replace(value,'/runtime')
            return {'text':text,'cursor':max(cursor,start)+len(data),'truncated':cursor<start}
        if op=='job.artifacts':
            root=p/'output';result=[]
            if root.exists():
                with directory(root) as top:
                    for components,fd in walk_files(top):
                        result.append({'path':'/'.join(components),'bytes':os.fstat(fd).st_size})
                        if len(result)>10000:raise ValueError('artifact_listing_limit')
            return {'artifacts':result}
        ws=p/'output'
    if op in ('file.read','artifact.read'):
        offset=r.get('offset',0);size=r.get('size',1024*1024)
        if type(offset) is not int or offset<0 or type(size) is not int or not 1<=size<=2*1024*1024:raise ValueError('invalid_range')
        with os.fdopen(open_file(ws,r.get('path')),'rb') as f:
            st=os.fstat(f.fileno());version=hashlib.sha256(str((st.st_ino,st.st_size,st.st_mtime_ns)).encode()).hexdigest()
            if r.get('version') and r['version']!=version:raise ValueError('artifact_changed')
            f.seek(offset);data=f.read(size);end=os.fstat(f.fileno());total=st.st_size
            if (st.st_size,st.st_mtime_ns)!=(end.st_size,end.st_mtime_ns):raise ValueError('artifact_changed')
        return {'data':base64.b64encode(data).decode(),'offset':offset,'bytes':len(data),'total':total,'version':version,'sha256':hashlib.sha256(data).hexdigest()}
    if op=='file.write':
        text=r.get('content')
        if not isinstance(text,str) or len(text.encode())>2*1024*1024:raise ValueError('file_too_large')
        write_file(ws,r.get('path'),text.encode('utf-8'))
        return {'written':True,'bytes':len(text.encode('utf-8'))}
    if op=='file.list':
        parts=() if r.get('path','.')=='.' else relative(r['path'])
        with directory(ws,parts) as fd:
            names=os.listdir(fd)
            if len(names)>10000:raise ValueError('listing_too_large')
            result=[]
            for name in sorted(names):
                st=os.stat(name,dir_fd=fd,follow_symlinks=False)
                result.append({'name':name,'kind':'directory' if stat.S_ISDIR(st.st_mode) else 'file' if stat.S_ISREG(st.st_mode) else 'unavailable','bytes':st.st_size})
            return {'entries':result}
    if op=='dataset.publish':return publish(cfg,wid,r['path'])
    if op=='dataset.list':
        return {'datasets':[{k:v for k,v in read_json(p/'manifest.json').items() if k!='files'} for p in (pathlib.Path(cfg['state'])/'datasets').iterdir() if re.fullmatch('[a-f0-9]{32}',p.name) and (p/'manifest.json').is_file()]}
    if op=='upload.begin':
        relative(r['path'])
        if type(r['bytes']) is not int or not 0<=r['bytes']<=cfg.get('upload_max_bytes',100*1024**3) or not re.fullmatch('[a-f0-9]{64}',r['sha256']):raise ValueError('invalid_upload')
        uid=uuid.uuid4().hex;folder=pathlib.Path(cfg['state'])/'uploads'/uid;folder.mkdir(mode=0o700)
        save(folder/'meta.json',{'workspace':wid,'path':r['path'],'bytes':r['bytes'],'sha256':r['sha256']})
        (folder/'content').touch(mode=0o600);return {'id':uid,'offset':0}
    if op.startswith('upload.'):
        folder=pathlib.Path(cfg['state'])/'uploads'/identity(r['upload']);meta=read_json(folder/'meta.json')
        if meta['workspace']!=wid:raise ValueError('upload_not_found')
        with (folder/'lock').open('a') as mutex:
            fcntl.flock(mutex,fcntl.LOCK_EX);file=folder/'content'
            receipt=folder/'receipt.json'
            if receipt.exists():
                return read_json(receipt) if op=='upload.finish' else {'id':r['upload'],'offset':meta['bytes'],'complete':True}
            if not file.exists():
                # Recover a successful atomic move whose acknowledgement was interrupted.
                with os.fdopen(open_file(ws,meta['path']),'rb') as final:
                    h=hashlib.sha256();before=os.fstat(final.fileno())
                    for block in iter(lambda:final.read(1024*1024),b''):h.update(block)
                    after=os.fstat(final.fileno())
                if before.st_size!=meta['bytes'] or h.hexdigest()!=meta['sha256'] or (before.st_size,before.st_mtime_ns)!=(after.st_size,after.st_mtime_ns):raise ValueError('upload_finalization_unverified')
                result={'path':meta['path'],'bytes':meta['bytes'],'sha256':meta['sha256']};save(receipt,result)
                return result if op=='upload.finish' else {'id':r['upload'],'offset':meta['bytes'],'complete':True}
            if op=='upload.chunk':
                data=base64.b64decode(r['data'],validate=True);offset=r['offset']
                if len(data)>2*1024*1024 or type(offset) is not int or offset<0 or offset+len(data)>meta['bytes'] or hashlib.sha256(data).hexdigest()!=r['sha256']:raise ValueError('upload_integrity')
                with file.open('r+b') as f:
                    current=file.stat().st_size
                    if offset<current:
                        f.seek(offset)
                        if f.read(len(data))!=data:raise ValueError('upload_conflict')
                    elif offset==current:f.seek(offset);f.write(data)
                    else:raise ValueError('upload_offset')
                return {'id':r['upload'],'offset':file.stat().st_size}
            if file.stat().st_size!=meta['bytes'] or digest(file)!=meta['sha256']:raise ValueError('upload_incomplete')
            result={'path':meta['path'],'bytes':meta['bytes'],'sha256':meta['sha256']}
            parts=relative(meta['path']);file.chmod(0o666)
            with directory(ws,parts[:-1],create=True) as destination,directory(folder) as source:
                os.replace('content',parts[-1],src_dir_fd=source,dst_dir_fd=destination)
            save(receipt,result)
        return result
    raise ValueError('unsupported_operation')


def main():
    cfg=configuration()
    if sys.argv[1:] and sys.argv[1]=='run':run_job(cfg,identity(sys.argv[2]));return
    try:
        data=sys.stdin.buffer.read(LIMIT+1)
        if len(data)>LIMIT:raise ValueError('request_too_large')
        request=json.loads(data)
        if not isinstance(request,dict):raise ValueError('invalid_request')
        response={'ok':True,'result':dispatch(cfg,request)}
    except Exception as exc:
        error=str(exc) if isinstance(exc,ValueError) and re.fullmatch('[a-z0-9_]{1,80}',str(exc)) else 'operation_failed'
        response={'ok':False,'error':error}
    print(json.dumps(response,ensure_ascii=False))


if __name__=='__main__':main()
