import json
import os
import pathlib
import socket
import urllib.request

def tcp(host, port):
    try:
        with socket.create_connection((host, port), timeout=1):
            return True
    except OSError:
        return False

def udp():
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.settimeout(1)
        s.sendto(b'blocked-probe', ('1.1.1.1', 53))
        s.recv(64)
        return True
    except OSError:
        return False

def proxy():
    try:
        p = urllib.request.ProxyHandler({'https': 'http://127.0.0.1:13128'})
        with urllib.request.build_opener(p).open('https://example.com', timeout=20) as r:
            return r.status == 200
    except Exception:
        return False

def vsock_denied():
    try:
        socket.socket(40, socket.SOCK_STREAM).close()
        return False
    except OSError:
        return True

checks = {
    'hostname': socket.gethostname(), 'user': os.getenv('USER'),
    'timezone': os.getenv('TZ'), 'language': os.getenv('LANG'), 'encoding': __import__('locale').getpreferredencoding(),
    'windowsMountAbsent': not pathlib.Path('/mnt/c').exists(),
    'windowsInteropAbsent': not pathlib.Path('/init').exists() and 'WSL_INTEROP' not in os.environ,
    'operatorHomeAbsent': list(pathlib.Path('/home').iterdir()) == [pathlib.Path('/home/agent')],
    'credentialEnvironmentAbsent': not any(k.startswith(('SSH_', 'AWS_', 'ALIYUN_', 'AZURE_', 'CLOUDFLARE_')) for k in os.environ),
    'emptyCapabilities': 'CapEff:\t0000000000000000' in pathlib.Path('/proc/self/status').read_text(),
    'privateProcessView': not pathlib.Path('/proc/1/root/mnt/c').exists(),
    'noDirectRoute': len(pathlib.Path('/proc/net/route').read_text().strip().splitlines()) == 1,
    'directTcpDenied': not tcp('1.1.1.1', 443), 'metadataDenied': not tcp('169.254.169.254', 80),
    'directIpv6Denied': not tcp('2606:4700:4700::1111', 443), 'directDnsDenied': not udp(),
    'virtualHostSocketDenied': vsock_denied(),
    'controlledHttps': proxy(),
}
print(json.dumps(checks))
