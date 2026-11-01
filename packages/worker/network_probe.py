"""Small task-only network and filesystem acceptance probe."""
import json
import os
import pathlib
import socket
import urllib.request

def tcp(host, port):
    try:
        with socket.create_connection((host, port), timeout=1): return True
    except OSError: return False

def https(proxy):
    try:
        opener=urllib.request.build_opener(urllib.request.ProxyHandler({'https':proxy}))
        with opener.open('https://example.com',timeout=15) as r: return r.status==200
    except Exception: return False

def dns():
    try:
        with socket.socket(socket.AF_INET,socket.SOCK_DGRAM) as s:
            s.settimeout(1);s.sendto(b'probe',('1.1.1.1',53));s.recv(32);return True
    except OSError: return False

readonly=False
try:
    p=pathlib.Path('/usr/starport-write-probe');p.write_text('probe');p.unlink()
except OSError: readonly=True
checks={'directIpv4Denied':not tcp('1.1.1.1',443),'directIpv6Denied':not tcp('2606:4700:4700::1111',443),
        'dnsDenied':not dns(),'metadataDenied':not tcp('169.254.169.254',80),
        'controlledHttps':https('http://127.0.0.1:18080'),'unavailableProxyFails':not https('http://127.0.0.1:9'),
        'operatorFilesAbsent':not any(pathlib.Path(p).exists() for p in ['/root/.ssh','/root/.local/share/starport-next-worker','/mnt/c']),
        'operatorEnvironmentAbsent':not any(k.startswith(('SSH_','AWS_','ALIYUN_','CLOUDFLARE_')) for k in os.environ),
        'rootfsReadonly':readonly}
checks['passed']=all(checks.values())
print(json.dumps(checks));assert checks['passed']
pathlib.Path('/output/result.txt').write_text('STARPORT_REMOTE_OK\n')
