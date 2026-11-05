"""Runs INSIDE the namespace; only bridges neutral loopback ports to scoped sockets."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import threading


def bridge(port, channel):
    listener = socket.socket()
    listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    listener.bind(('127.0.0.1', port))
    listener.listen(32)

    def pump(src, dst):
        try:
            while True:
                data = src.recv(16384)
                if not data:
                    break
                dst.sendall(data)
        except OSError:
            pass
        finally:
            try:
                dst.shutdown(socket.SHUT_WR)
            except OSError:
                pass

    def forward(client):
        remote = socket.socket(socket.AF_UNIX)
        try:
            remote.connect('/run/bridge/' + channel + '.sock')
            t = threading.Thread(target=pump, args=(client, remote), daemon=True)
            t.start()
            pump(remote, client)
        except OSError:
            pass
        finally:
            remote.close()
            client.close()

    def accept():
        while True:
            client, _ = listener.accept()
            threading.Thread(target=forward, args=(client,), daemon=True).start()
    threading.Thread(target=accept, daemon=True).start()


def main():
    request = json.loads(sys.stdin.readline())
    for port, channel in [(13128, 'proxy'), (18080, 'model'), (18081, 'compute')]:
        bridge(port, channel)
    # These are project capabilities, not operator tokens or endpoint addresses.
    if request.get('modelCapability') and request['operation'] != 'native':
        os.environ['ANTHROPIC_BASE_URL'] = 'http://127.0.0.1:18080'
        os.environ['ANTHROPIC_API_KEY'] = request['modelCapability']
    os.environ['STARPORT_COMPUTE_URL'] = 'http://127.0.0.1:18081'
    os.environ['STARPORT_COMPUTE_TOKEN'] = request.get('computeCapability', 'unavailable')
    if request['operation'] == 'native':
        for name in ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']:
            os.environ.pop(name, None)
        # This trusted supervisor owns the control pipe. Applications get a TTY
        # or /dev/null, never the operator protocol on stdin.
        mode = request.get('credentialStorage', 'keyring')
        if mode not in ('keyring', 'basic'):
            raise ValueError('invalid_credential_storage')
        os.environ['STARPORT_CREDENTIAL_STORAGE'] = mode
        import runpy
        runpy.run_path('/opt/starport/native-session.py', run_name='__main__')
        return 0
    if request['operation'] == 'sdk':
        if not request.get('modelCapability'):
            raise ValueError('api_gateway_required')
        return subprocess.run(['/usr/local/bin/node', '/opt/starport/sdk-agent.mjs'],
                              input=json.dumps(request['request']), text=True).returncode
    if request['operation'] == 'files':
        result = subprocess.run(['/usr/bin/python3', '-I', '/opt/starport/files.py'],
                                input=json.dumps(request['request']), text=True)
        return result.returncode
    return subprocess.call(request['argv'], stdin=subprocess.DEVNULL)


if __name__ == '__main__':
    sys.exit(main())
