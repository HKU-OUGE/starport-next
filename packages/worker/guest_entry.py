# Derived from Starport Pi (MIT), Copyright (c) 2026 Starport contributors.
# Maintained here as the standalone Starport Next worker. See THIRD_PARTY.md.
"""Inside the sandbox only: bridge loopback HTTP to the task's sole egress socket."""
import os
import pathlib
import select
import socket
import socketserver
import subprocess
import sys
import threading
import signal


class Forward(socketserver.BaseRequestHandler):
    def handle(self):
        upstream = socket.socket(socket.AF_UNIX)
        try:
            upstream.connect('/run/starport/egress.sock')
            peers = (self.request, upstream)
            while True:
                ready, _, _ = select.select(peers, [], [], 60)
                if not ready:
                    return
                for source in ready:
                    block = source.recv(65536)
                    if not block:
                        return
                    peers[1 if source is peers[0] else 0].sendall(block)
        except OSError:
            return
        finally:
            upstream.close()


class Proxy(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == '__main__':
    if pathlib.Path('/run/starport/egress.sock').is_socket():
        server = Proxy(('127.0.0.1', 18080), Forward)
        threading.Thread(target=server.serve_forever, daemon=True).start()
    # Missing or dead egress always fails locally; never unset the proxy or retry direct.
    budget=int(sys.argv[1])
    child=subprocess.Popen(sys.argv[2:], env=os.environ.copy(),start_new_session=True)
    try:code=child.wait(timeout=budget)
    except subprocess.TimeoutExpired:
        os.killpg(child.pid,signal.SIGKILL);child.wait();code=124
    sys.exit(code)
