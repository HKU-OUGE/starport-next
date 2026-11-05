"""Run once as root in a newly imported, owned Ubuntu WSL2 distribution."""
import base64
import json
import os
import pathlib
import pwd
import grp
import subprocess
import sys

q = json.load(sys.stdin)
if os.geteuid() != 0 or not q.get('owner'):
    raise SystemExit('owned_distribution_required')
root = pathlib.Path('/opt/starport-wsl')
root.mkdir(mode=0o755, exist_ok=True)
marker = root / 'owner'
if marker.exists() and marker.read_text() != q['owner']:
    raise SystemExit('distribution_owner_mismatch')
marker.write_text(q['owner'])
marker.chmod(0o600)
mode=q.get('runtime', 'wsl2')
if mode not in ('wsl2','qemu'): raise SystemExit('invalid_runtime_kind')
if mode=='qemu' and pwd.getpwnam('agent').pw_uid!=1000: raise SystemExit('project_vm_identity_mismatch')
env = {'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'DEBIAN_FRONTEND': 'noninteractive', 'TZ': 'Asia/Taipei'}
if mode=='qemu':
    proxy=q.get('proxy')
    if proxy!='http://127.0.0.1:13129': raise SystemExit('controlled_install_proxy_required')
    env.update(HTTP_PROXY=proxy,HTTPS_PROXY=proxy,http_proxy=proxy,https_proxy=proxy,NO_PROXY='localhost,127.0.0.1')
    sources=pathlib.Path('/etc/apt/sources.list.d/ubuntu.sources')
    sources.write_text(sources.read_text().replace('http://archive.ubuntu.com/','https://archive.ubuntu.com/').replace('http://security.ubuntu.com/','https://security.ubuntu.com/').replace('http://ports.ubuntu.com/','https://ports.ubuntu.com/'))
for command in [
    ['apt-get', 'update'],
    ['apt-get', 'install', '-y', '--no-install-recommends', 'bubblewrap', 'libseccomp2', 'python3', 'ca-certificates',
     'locales', 'tzdata', 'fonts-noto-cjk', 'curl', 'git'],
    ['localedef', '-i', 'zh_TW', '-f', 'UTF-8', 'zh_TW.UTF-8'],
    ['localedef', '-i', 'en_US', '-f', 'UTF-8', 'en_US.UTF-8'],
]:
    subprocess.run(command, check=True, env=env, stdout=sys.stderr)
if mode=='qemu':
    exec(compile(q['security'], 'project-security', 'exec'))
# The normal WSL entry is non-administrative. Only the Windows controller
# explicitly invokes root; project programs never receive that launcher.
try:
    existing = pwd.getpwuid(1000)
    if existing.pw_name != 'agent':
        subprocess.run(['usermod', '-l', 'agent', existing.pw_name], check=True, env=env)
except KeyError:
    try:
        grp.getgrgid(1000)
    except KeyError:
        subprocess.run(['groupadd', '-g', '1000', 'agent'], check=True, env=env)
    subprocess.run(['useradd', '-u', '1000', '-g', '1000', '-d', '/home/agent', '-s', '/usr/sbin/nologin', 'agent'], check=True, env=env)
subprocess.run(['usermod', '-G', '', '-d', '/home/agent', '-s', '/usr/sbin/nologin', '-L', 'agent'], check=True, env=env)
if mode=='wsl2':
    pathlib.Path('/etc/wsl.conf').write_text('[automount]\nenabled=false\nmountFsTab=false\n[interop]\nenabled=false\nappendWindowsPath=false\n[network]\nhostname=starship\n[time]\nuseWindowsTimezone=false\n[user]\ndefault=agent\n')
pathlib.Path('/etc/timezone').write_text('Asia/Taipei\n')
localtime = pathlib.Path('/etc/localtime')
localtime.unlink(missing_ok=True)
localtime.symlink_to('/usr/share/zoneinfo/Asia/Taipei')
pathlib.Path('/etc/default/locale').write_text('LANG=zh_TW.UTF-8\nLC_ALL=zh_TW.UTF-8\nLANGUAGE=zh_TW:en_US\n')
for name, content in q['files'].items():
    if name not in ['runner.py', 'guest-entry.py', 'files.py', 'native-session.py', 'credential-store.py', 'ime.py', 'ime-check.html', 'xpra-clipboard.py', 'sdk-agent.mjs', 'client-status.py', 'compute-mcp.py', 'configure-compute.py', 'COMPUTE-AGENT.md', 'compute-client.py']:
        raise SystemExit('invalid_runtime_file')
    public = root / 'public'
    public.mkdir(mode=0o755, exist_ok=True)
    target = (root if name == 'runner.py' else public) / name
    target.write_bytes(base64.b64decode(content, validate=True))
    target.chmod(0o644)
etc = root / 'etc'
etc.mkdir(mode=0o755, exist_ok=True)
locale_dir = etc / 'locale-data'
locale_dir.mkdir(mode=0o755, exist_ok=True)
for language in ['zh_TW', 'en_US']:
    subprocess.run(['localedef', '--no-archive', '-i', language, '-f', 'UTF-8', str(locale_dir / (language + '.utf8'))], check=True, env=env)
for name, content in {
    'passwd': 'root:x:0:0:root:/root:/usr/sbin/nologin\nagent:x:1000:1000:agent:/home/agent:/bin/bash\n',
    'group': 'root:x:0:\nagent:x:1000:\n',
    'hosts': '127.0.0.1 localhost starship\n::1 localhost\n',
    'hostname': 'starship\n', 'resolv.conf': 'nameserver 127.0.0.1\n',
    'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files dns\n',
    'timezone': 'Asia/Taipei\n', 'locale.conf': 'LANG=zh_TW.UTF-8\nLC_ALL=zh_TW.UTF-8\n',
}.items():
    (etc / name).write_text(content)
for name, source in [('ssl/certs', '/etc/ssl/certs'), ('fonts', '/etc/fonts'), ('localtime', '/usr/share/zoneinfo/Asia/Taipei')]:
    # Copy only public system trust, fonts and timezone data, never all of /etc.
    import shutil
    target = etc / name
    target.parent.mkdir(mode=0o755, parents=True, exist_ok=True)
    if target.exists():
        if target.is_dir(): shutil.rmtree(target)
        else: target.unlink()
    if pathlib.Path(source).is_dir():
        shutil.copytree(source, target, symlinks=False)
    else:
        shutil.copyfile(source, target)
print(json.dumps({'installed': True, 'restartOwnedDistribution': mode=='wsl2', 'locale': 'zh_TW.UTF-8', 'timezone': 'Asia/Taipei'}))
