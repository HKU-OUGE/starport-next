# Derived from Starport Pi (MIT), Copyright (c) 2026 Starport contributors.
# Maintained here as the standalone Starport Next worker. See THIRD_PARTY.md.
"""Operator-only GPU setup. Never installs drivers or reconfigures other services."""
import argparse
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys

# Python -I intentionally omits the script directory from sys.path.
sys.path.insert(0,str(pathlib.Path(__file__).resolve().parent))
from worker import configuration,lock,records,save,ROOT


def discover(cfg,indices):
    supported=subprocess.check_output([cfg['runsc'],'nvproxy','list-supported-drivers'],text=True,timeout=15).split()
    rows=subprocess.check_output(['nvidia-smi','--query-gpu=index,driver_version','--format=csv,noheader,nounits'],text=True,timeout=15)
    drivers={int(row.split(',')[0]):row.split(',')[1].strip() for row in rows.splitlines()}
    if not indices or not set(indices)<=drivers.keys():raise ValueError('gpu_selection_invalid')
    if any(drivers[i] not in supported for i in indices):raise ValueError('gpu_driver_not_supported')
    cache=subprocess.check_output(['/sbin/ldconfig','-p'],text=True,timeout=15)
    libraries={}
    for line in cache.splitlines():
        match=re.match(r'\s*(lib(?:cuda|nvidia-(?:ml|ptxjitcompiler|nvvm))\.so(?:\.[\w.]+)?)\s.*=>\s*(/\S+)',line)
        if match:libraries.setdefault(match[1],pathlib.Path(match[2]).resolve(strict=True))
    if not {'libcuda.so.1','libnvidia-ml.so.1'}<=libraries.keys():raise ValueError('gpu_user_libraries_missing')
    files=[]
    for name,source in sorted(libraries.items()):
        if not source.is_file():raise ValueError('gpu_library_invalid')
        h=hashlib.sha256()
        with source.open('rb') as f:
            for block in iter(lambda:f.read(1024*1024),b''):h.update(block)
        files.append({'source':str(source),'destination':'/opt/starport-driver/'+name,'sha256':h.hexdigest()})
    return files,sorted(set(drivers[i] for i in indices))


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--indices',required=True,help='Comma-separated GPUs reserved for this service')
    parser.add_argument('--apply',action='store_true')
    args=parser.parse_args();indices=[int(v) for v in args.indices.split(',')]
    if len(set(indices))!=len(indices) or any(v<0 for v in indices):raise ValueError('gpu_selection_invalid')
    cfg=configuration();files,versions=discover(cfg,indices)
    if args.apply:
        with lock(cfg):
            if any(not r.get('released') for _,r in records(cfg)):raise ValueError('wait_for_this_workers_jobs')
            target=pathlib.Path(cfg['rootfs'])/'opt/starport-driver';target.mkdir(exist_ok=True)
            for row in files:(target/pathlib.Path(row['destination']).name).touch(exist_ok=True)
            cfg.update(gpu_indices=indices,driver_files=files)
            save(ROOT/'config.json',cfg)
    print(json.dumps({'compatible':True,'applied':args.apply,'gpus':len(indices),'driver_versions':versions,'library_files':len(files)}))


if __name__=='__main__':
    try:main()
    except Exception as exc:
        print(str(exc) if isinstance(exc,ValueError) else 'gpu_setup_failed',file=sys.stderr);sys.exit(1)
