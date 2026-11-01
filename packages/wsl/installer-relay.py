"""Trusted, temporary installer proxy over stdio; no Windows inbound listener."""
import base64
import contextlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import threading

q = json.loads(sys.stdin.buffer.readline(16 * 1024 * 1024))
assert os.geteuid() == 0 and pathlib.Path('/opt/starport-wsl/owner').read_text() == q['owner']
output = threading.Lock()
mutex = threading.Lock()
peers = {}
sequence = 0


def send(frame):
    with output:
        sys.stdout.write(json.dumps(frame, separators=(',', ':')) + '\n')
        sys.stdout.flush()


def close(number):
    with mutex:
        peer = peers.pop(number, None)
    if peer:
        with contextlib.suppress(OSError):
            peer.shutdown(socket.SHUT_RDWR)
        peer.close()


def read_peer(number, peer):
    try:
        send({'type': 'open', 'channel': 'proxy', 'id': number})
        while True:
            data = peer.recv(16384)
            if not data:
                break
            send({'type': 'data', 'id': number, 'data': base64.b64encode(data).decode()})
    except OSError:
        pass
    finally:
        close(number)
        send({'type': 'close', 'id': number})


listener = socket.socket()
listener.bind(('127.0.0.1', 0))
listener.listen(32)
q['request']['proxy'] = 'http://127.0.0.1:' + str(listener.getsockname()[1])


def accept():
    global sequence
    while True:
        try:
            peer, _ = listener.accept()
        except OSError:
            return
        with mutex:
            if len(peers) >= 48:
                peer.close()
                continue
            sequence += 1
            number = sequence
            peers[number] = peer
        peer.settimeout(120)
        threading.Thread(target=read_peer, args=(number, peer), daemon=True).start()


threading.Thread(target=accept, daemon=True).start()
child = subprocess.Popen(['/usr/bin/python3', '-I', '-c', q['script']],
                         stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                         env={'PATH': '/usr/local/bin:/usr/bin:/bin'}, start_new_session=True)
child.stdin.write(json.dumps(q['request']).encode())
child.stdin.close()


def input_frames():
    try:
        while True:
            line = sys.stdin.buffer.readline(32769)
            if not line:
                break
            assert len(line) <= 32768 and line.endswith(b'\n')
            frame = json.loads(line)
            number = frame['id']
            assert type(number) is int and number > 0
            if frame['type'] == 'close':
                close(number)
            else:
                assert frame['type'] == 'data'
                data = base64.b64decode(frame['data'], validate=True)
                assert len(data) <= 16384
                with mutex:
                    peer = peers.get(number)
                if peer:
                    try:
                        peer.sendall(data)
                    except OSError:
                        close(number)
    finally:
        for number in list(peers):
            close(number)
        with contextlib.suppress(ProcessLookupError):
            os.killpg(child.pid, signal.SIGTERM)


threading.Thread(target=input_frames, daemon=True).start()
while True:
    data = child.stdout.read1(8192)
    if not data:
        break
    send({'type': 'output', 'stream': 'stdout', 'data': base64.b64encode(data).decode()})
code = child.wait()
send({'type': 'exit', 'code': code})
listener.close()
for number in list(peers):
    close(number)
