"""Operator-only additive install from a verified local runtime dependency cache.

Input is supplied by the trusted installer, never an Agent request. Dependencies
are copied into an independent root; existing workers and their state stay intact.
"""
import base64
import hashlib
import json
import os
import pathlib
import shutil
import stat
import subprocess
import sys
import tempfile
import uuid

def digest(p):
    h = hashlib.sha256()
    with p.open('rb') as f:
        for b in iter(lambda: f.read(1024*1024), b''): h.update(b)
    return h.hexdigest()

def provision(d):
    root = pathlib.Path.home()/'.local/share/starport-next-worker'
    if root.exists(): raise ValueError('existing_next_worker_requires_reconciliation')
    source = pathlib.Path(d['dependencyRoot']).resolve(strict=True)
    c = json.loads((source/'config.json').read_text())
    if c['format'] != 1: raise ValueError('unsupported_dependency_source')
    for name, expected in c['runtime_files'].items():
        p = source/name
        if p.is_symlink() or not p.is_file() or digest(p) != expected: raise ValueError('runtime_dependency_checksum')
    base = pathlib.Path(c['rootfs']).resolve(strict=True)
    if not base.is_relative_to(source): raise ValueError('dependency_root_mismatch')
    files = []
    for folder, dirs, names in os.walk(base, followlinks=False):
        for name in names:
            p = pathlib.Path(folder)/name
            if p.is_symlink(): continue
            if not p.is_file(): raise ValueError('special_dependency_file')
            files.append((p.relative_to(base), p.stat().st_size))
    total = sum(n for _, n in files)
    if shutil.disk_usage(root.parent).free < total + 1024**3: raise ValueError('worker_disk_space')
    cpus = d['cpuIndices']
    if not cpus or len(cpus)>512 or len(set(cpus))!=len(cpus) or not set(cpus)<=set(os.sched_getaffinity(0)): raise ValueError('invalid_cpu_reservation')
    if not 2<=d['memoryGiB']<=4096 or not set(d['gpuIndices'])<=set(c.get('gpu_indices',[])): raise ValueError('invalid_worker_budget')
    stage = pathlib.Path(tempfile.mkdtemp(prefix='starport-next-install-',dir=root.parent))
    try:
        # Reflink is copy-on-write, not a shared hardlink; fallback makes full copies.
        subprocess.run(['cp','-a','--reflink=auto',str(base),str(stage/'rootfs')],check=True)
        manifest = hashlib.sha256()
        for relative, size in files:
            a, b = base/relative, stage/'rootfs'/relative
            h = digest(a)
            if digest(b)!=h or a.stat().st_ino==b.stat().st_ino: raise ValueError('dependency_copy_integrity')
            manifest.update(str(relative).encode()+b'\0'+h.encode())
        for name in c['runtime_files']:
            target=stage/name;target.parent.mkdir(parents=True,exist_ok=True)
            shutil.copy2(source/name,target)
        for name, encoded in d['sources'].items():
            if name not in ['worker.py','configure_gpu.py','guest_entry.py','probe.py','gpu_probe.py']: raise ValueError('invalid_worker_source')
            (stage/name).write_bytes(base64.b64decode(encoded,validate=True))
        for name in ['guest_entry.py','probe.py','gpu_probe.py']:
            shutil.copyfile(stage/name,stage/'rootfs/opt/starport'/name)
        shutil.copyfile(stage/'rootfs/opt/starport/region.json',stage/'region.json')
        egress=pathlib.Path('/tmp')/('starport-egress-'+uuid.uuid4().hex)
        egress.mkdir(mode=0o700)
        cfg={'format':1,'state':str(root/'state'),'rootfs':str(root/'rootfs'),'runsc':str(root/'runsc'),
             'runsc_sha256':c['runtime_files']['runsc'],'runtime_files':c['runtime_files'],'region_sha256':digest(stage/'region.json'),
             'cpu_indices':cpus,'memory_gib':d['memoryGiB'],'max_parallel':d['maxParallel'],
             'gpu_indices':d['gpuIndices'],'driver_files':c.get('driver_files',[]) if d['gpuIndices'] else [],
             'platform':c.get('platform','systrap'),'egress_socket':str(egress/'proxy.sock')}
        # Driver files refer to the operating system, never another worker root.
        for row in cfg['driver_files']:
            p=pathlib.Path(row['source']).resolve(strict=True)
            if p.is_relative_to(source) or digest(p)!=row['sha256']: raise ValueError('driver_source_invalid')
        (stage/'config.json').write_text(json.dumps(cfg,indent=2));(stage/'config.json').chmod(0o600)
        for part in ['workspaces','jobs','datasets','uploads']:(stage/'state'/part).mkdir(parents=True,mode=0o700)
        receipt={'installed':True,'owner':d['owner'],'dependencyManifest':manifest.hexdigest(),'files':len(files),'bytes':total,
                 'runtimeFiles':c['runtime_files'],'sources':{name:digest(stage/name) for name in d['sources']},
                 'cpus':len(cpus),'memoryGiB':d['memoryGiB'],'gpus':len(d['gpuIndices']),'independentCopies':True}
        (stage/'installation.json').write_text(json.dumps(receipt,indent=2));(stage/'installation.json').chmod(0o600)
        stage.rename(root)
        return receipt
    except BaseException:
        # Only this invocation's private staging directory is eligible for cleanup.
        if stage.exists(): shutil.rmtree(stage)
        raise

if __name__=='__main__':
    print(json.dumps(provision(json.load(sys.stdin))))
