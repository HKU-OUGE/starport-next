# Derived from Starport Pi (MIT), Copyright (c) 2026 Starport contributors.
# Maintained independently by Next; see THIRD_PARTY.md.
"""Install a private, additive runsc worker on an existing Linux/DSW server."""
import argparse
import hashlib
import json
import os
import pathlib
import shutil
import subprocess
import sys
import tarfile
import tempfile
import uuid
import contextlib


@contextlib.contextmanager
def parent_fd(root,parts):
    fd=os.open(root,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        for part in parts:
            nxt=os.open(part,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd)
            os.close(fd);fd=nxt
        yield fd
    finally:os.close(fd)


def sha(path):
    result=hashlib.sha256()
    with open(path,'rb') as stream:
        for data in iter(lambda:stream.read(1024*1024),b''):result.update(data)
    return result.hexdigest()


def unpack(archive,destination):
    """Extract regular files first and links last; never traverse an archive link."""
    links=[];total=0;seen=set()
    with tarfile.open(archive,'r:*') as tar:
        members=tar.getmembers()
        if len(members)>150000:raise ValueError('rootfs_file_limit')
        for member in members:
            relative=pathlib.PurePosixPath(member.name.removeprefix('./'))
            if str(relative)=='.':continue
            if relative.is_absolute() or '..' in relative.parts or str(relative) in seen:raise ValueError('invalid_rootfs_path')
            seen.add(str(relative));target=destination/relative
            if member.issym() or member.islnk():links.append((member,target));continue
            if not member.isdir() and not member.isfile():
                if relative.parts[0]=='dev':continue
                raise ValueError('rootfs_special_file')
            target.parent.mkdir(parents=True,exist_ok=True)
            if member.isdir():target.mkdir(exist_ok=True);target.chmod(member.mode&0o755)
            else:
                total+=member.size
                if total>6*1024**3:raise ValueError('rootfs_size_limit')
                with tar.extractfile(member) as source,target.open('xb') as out:shutil.copyfileobj(source,out,1024*1024)
                target.chmod(member.mode&0o755)
        for member,target in links:target.parent.mkdir(parents=True,exist_ok=True)
        for member,target in links:
            destination_parts=target.relative_to(destination).parts
            if member.islnk():
                source=pathlib.PurePosixPath(member.linkname.removeprefix('./'))
                if source.is_absolute() or '..' in source.parts:raise ValueError('invalid_rootfs_link')
                with parent_fd(destination,source.parts[:-1]) as source_fd,parent_fd(destination,destination_parts[:-1]) as dest_fd:
                    import stat
                    st=os.stat(source.name,dir_fd=source_fd,follow_symlinks=False)
                    if not stat.S_ISREG(st.st_mode):raise ValueError('invalid_rootfs_link')
                    os.link(source.name,destination_parts[-1],src_dir_fd=source_fd,dst_dir_fd=dest_fd,follow_symlinks=False)
            else:
                if '\x00' in member.linkname:raise ValueError('invalid_rootfs_link')
                # Absolute targets resolve inside the guest; no further extraction follows them.
                with parent_fd(destination,destination_parts[:-1]) as fd:os.symlink(member.linkname,destination_parts[-1],dir_fd=fd)


def install(args):
    if sys.platform!='linux': raise ValueError('linux_server_required')
    if not args.owner or len(args.owner)!=64 or any(c not in '0123456789abcdef' for c in args.owner): raise ValueError('installation_owner_required')
    if sha(args.rootfs)!=args.sha256 or sha(args.runtime_archive)!=args.runtime_sha256: raise ValueError('archive_checksum_failed')
    affinity=sorted(os.sched_getaffinity(0))
    if not 1<=args.cpus<=min(512,len(affinity)) or not 2<=args.memory_gib<=4096: raise ValueError('invalid_server_budget')
    root=pathlib.Path.home()/'.local/share/starport-next-worker'
    if root.exists(): raise ValueError('existing_next_worker_requires_reconciliation')
    root.parent.mkdir(parents=True,exist_ok=True)
    stage=pathlib.Path(tempfile.mkdtemp(prefix='starport-next-install-',dir=root.parent))
    try:
        (stage/'rootfs').mkdir();unpack(args.rootfs,stage/'rootfs')
        for name in ['usr/local/bin/python3','bin/bash','opt/starport/region.json','etc/fonts/starport.conf']:
            p=stage/'rootfs'/name
            if not p.exists() and not p.is_symlink(): raise ValueError('rootfs_incomplete')
        extracted=stage/'runtime';extracted.mkdir();unpack(args.runtime_archive,extracted)
        shutil.move(extracted/'runsc',stage/'runsc')
        shutil.move(extracted/'gvisor-bin',stage/'gvisor-bin')
        shutil.rmtree(extracted)
        binaries={}
        for p in [stage/'runsc',*(stage/'gvisor-bin').iterdir()]:
            if p.is_symlink() or not p.is_file(): raise ValueError('invalid_runtime_file')
            p.chmod(0o755);binaries[str(p.relative_to(stage))]=sha(p)
        subprocess.run([str(stage/'runsc'),'--version'],check=True,capture_output=True,timeout=15)
        sources={}
        for name in ['worker.py','guest_entry.py','configure_gpu.py','probe.py','gpu_probe.py']:
            shutil.copyfile(pathlib.Path(__file__).with_name(name),stage/name);sources[name]=sha(stage/name)
        for name in ['guest_entry.py','probe.py','gpu_probe.py']:
            shutil.copyfile(stage/name,stage/'rootfs/opt/starport'/name)
        shutil.copyfile(stage/'rootfs/opt/starport/region.json',stage/'region.json')
        egress=pathlib.Path('/tmp')/('starport-egress-'+uuid.uuid4().hex);egress.mkdir(mode=0o700)
        (stage/'rootfs/run/starport').mkdir(parents=True,exist_ok=True)
        (stage/'rootfs/run/starport/egress.sock').touch()
        cfg={'format':1,'state':str(root/'state'),'rootfs':str(root/'rootfs'),'runsc':str(root/'runsc'),
             'runsc_sha256':binaries['runsc'],'runtime_files':binaries,'region_sha256':sha(stage/'region.json'),
             'cpu_indices':affinity[:args.cpus],'memory_gib':args.memory_gib,'max_parallel':None,
             'gpu_indices':[],'driver_files':[],'platform':'systrap','egress_socket':str(egress/'proxy.sock')}
        (stage/'config.json').write_text(json.dumps(cfg,indent=2));(stage/'config.json').chmod(0o600)
        for name in ['workspaces','jobs','datasets','uploads']:(stage/'state'/name).mkdir(parents=True,mode=0o700)
        receipt={'installed':True,'owner':args.owner,'rootfsSha256':args.sha256,'runtimeArchiveSha256':args.runtime_sha256,
                 'runtimeFiles':binaries,'sources':sources,'cpus':args.cpus,'memoryGiB':args.memory_gib,'gpus':0,
                 'independentCopies':True,'parallel':None}
        (stage/'installation.json').write_text(json.dumps(receipt,indent=2));(stage/'installation.json').chmod(0o600)
        stage.chmod(0o700);stage.rename(root)
        return receipt
    except BaseException:
        if stage.exists():shutil.rmtree(stage)
        raise

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--rootfs',type=pathlib.Path,required=True)
    p.add_argument('--sha256',required=True)
    p.add_argument('--runtime-archive',type=pathlib.Path,required=True)
    p.add_argument('--runtime-sha256',required=True)
    p.add_argument('--cpus',type=int,required=True)
    p.add_argument('--memory-gib',type=int,required=True)
    p.add_argument('--owner',required=True)
    print(json.dumps(install(p.parse_args())))

if __name__=='__main__':main()
