"""Trusted WSL controller. Model processes receive no stdio protocol or host sockets.

The transport follows the Starport Pi stdio/Unix-socket design (MIT).
This file is root owned, outside every writable project and namespace root.
"""
import base64
import contextlib
import ctypes
import fcntl
import json
import os
import pathlib
import re
import resource
import signal
import socket
import stat
import subprocess
import sys
import tempfile
import threading

BASE = pathlib.Path('/var/lib/starport-workspaces')
CODE = pathlib.Path('/opt/starport-wsl')
UID = 1000


def seccomp_filter(gui=False):
    """Close non-IP escape paths (notably Hyper-V/vsock) after bwrap setup."""
    lib = ctypes.CDLL('libseccomp.so.2', use_errno=True)
    class Comparison(ctypes.Structure):
        _fields_ = [('arg', ctypes.c_uint), ('op', ctypes.c_int),
                    ('datum_a', ctypes.c_uint64), ('datum_b', ctypes.c_uint64)]
    lib.seccomp_init.argtypes = [ctypes.c_uint32]
    lib.seccomp_init.restype = ctypes.c_void_p
    lib.seccomp_rule_add_array.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int,
                                          ctypes.c_uint, ctypes.POINTER(Comparison)]
    lib.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    lib.seccomp_syscall_resolve_name.restype = ctypes.c_int
    lib.seccomp_export_bpf.argtypes = [ctypes.c_void_p, ctypes.c_int]
    lib.seccomp_release.argtypes = [ctypes.c_void_p]
    ctx = lib.seccomp_init(0x7fff0000)  # ALLOW unless explicitly forbidden below.
    if not ctx:
        raise ValueError('seccomp_unavailable')
    fd = os.memfd_create('starport-policy', os.MFD_CLOEXEC)
    def deny(name, comparisons=()):
        nr = lib.seccomp_syscall_resolve_name(name.encode())
        if nr < 0:
            return
        values = (Comparison * len(comparisons))(*[Comparison(*v) for v in comparisons])
        if lib.seccomp_rule_add_array(ctx, 0x00050001, nr, len(values), values) != 0:
            raise ValueError('seccomp_policy_failed')
    try:
        for domain in [0, 3, 4, 5, 6, 7, 8, 9]:
            deny('socket', [(0, 4, domain, 0)])  # EQ
        deny('socket', [(0, 5, 11, 0)])  # GE; only UNIX, INET, INET6 survive.
        deny('socketpair', [(0, 1, 1, 0)])  # NE AF_UNIX
        # Chromium/Electron create nested user/PID/network namespaces for their
        # own sandbox. They cannot join an ancestor or mount outside this root.
        if not gui:
            deny('unshare')
        for name in ['setns', 'mount', 'umount2', 'pivot_root', 'move_mount',
                     'open_tree', 'fsopen', 'fsconfig', 'fsmount', 'fspick', 'mount_setattr',
                     'bpf', 'perf_event_open', 'ptrace', 'process_vm_readv', 'process_vm_writev',
                     'keyctl', 'add_key', 'request_key', 'userfaultfd', 'io_uring_setup',
                     'kexec_load', 'init_module', 'finit_module', 'delete_module', 'syslog']:
            deny(name)
        if lib.seccomp_export_bpf(ctx, fd) != 0:
            raise ValueError('seccomp_export_failed')
        os.lseek(fd, 0, os.SEEK_SET)
        return fd
    except Exception:
        os.close(fd)
        raise
    finally:
        lib.seccomp_release(ctx)


def prepare_workspace(base, name, uid=UID):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,47}', name):
        raise ValueError('invalid_workspace')
    base.mkdir(mode=0o755, parents=True, exist_ok=True)
    if base.is_symlink():
        raise ValueError('invalid_workspace_root')
    workspace = base / name
    workspace.mkdir(mode=0o755, exist_ok=True)
    if workspace.is_symlink():
        raise ValueError('invalid_workspace_root')
    # The parent stays controller-owned. Only these directories are exposed.
    for n in ['project', 'home', 'tmp']:
        p = workspace / n
        if p.is_symlink():
            raise ValueError('invalid_workspace_root')
        p.mkdir(mode=0o700, exist_ok=True)
        if os.geteuid() == 0:
            os.chown(p, uid, uid)
    return workspace


def sandbox_args(workspace, runtime, etc, code, uid=UID, seccomp_fd=None, gui=False, remote=False, seamless=False):
    args = ['/usr/bin/bwrap', '--unshare-all', '--unshare-user',
            '--die-with-parent', '--new-session', '--hostname', 'starship',
            '--uid', str(uid), '--gid', str(uid), '--cap-drop', 'ALL',
            '--clearenv', '--ro-bind', '/usr', '/usr']
    if not gui:
        args += ['--disable-userns']
    # No root bind, Windows drives, WSL interop, host home or host D-Bus.
    for n in ['bin', 'sbin', 'lib', 'lib64']:
        p = pathlib.Path('/') / n
        if p.is_symlink():
            args += ['--symlink', os.readlink(p), '/' + n]
        elif p.exists():
            args += ['--ro-bind', str(p), '/' + n]
    args += ['--ro-bind', str(etc), '/etc', '--proc', '/proc', '--tmpfs', '/proc/sys',
             '--dev', '/dev', '--dir', '/sys', '--dir', '/run',
             '--ro-bind', str(runtime), '/run/bridge',
             '--ro-bind', str(code), '/opt/starport',
             '--bind', str(workspace / 'project'), '/workspace',
             '--bind', str(workspace / 'home'), '/home/agent',
             '--bind', str(workspace / 'tmp'), '/tmp', '--chdir', '/workspace']
    env = {'HOME': '/home/agent', 'USER': 'agent', 'LOGNAME': 'agent',
           'PATH': '/usr/local/bin:/usr/bin:/bin', 'LANG': 'zh_TW.UTF-8',
           'LC_ALL': 'zh_TW.UTF-8', 'LANGUAGE': 'zh_TW:en_US', 'TZ': 'Asia/Taipei',
           'HTTP_PROXY': 'http://127.0.0.1:13128', 'HTTPS_PROXY': 'http://127.0.0.1:13128',
           'ALL_PROXY': 'http://127.0.0.1:13128', 'NO_PROXY': '127.0.0.1,localhost',
           'PYTHONUTF8': '1', 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_CONFIG_GLOBAL': '/dev/null'}
    for k, v in env.items():
        args += ['--setenv', k, v]
    if (etc / 'locale-data').is_dir():
        args += ['--setenv', 'LOCPATH', '/etc/locale-data']
    # Only selected, public client dependencies are exposed read-only.
    for dependency in ['/opt/google/chrome', '/opt/claude-desktop']:
        if pathlib.Path(dependency).is_dir():
            args += ['--ro-bind', dependency, dependency]
    if gui and remote:
        args += ['--perms', '0700', '--dir', '/run/user/1000',
                 '--tmpfs', '/tmp/.X11-unix',
                 '--setenv', 'XDG_RUNTIME_DIR', '/run/user/1000',
                 '--setenv', 'DISPLAY', ':1', '--setenv', 'STARPORT_REMOTE_DISPLAY', '1']
        if seamless:
            args += ['--setenv', 'STARPORT_SEAMLESS_DISPLAY', '1']
    elif gui:
        wayland = pathlib.Path('/mnt/wslg/runtime-dir/wayland-0')
        x11 = pathlib.Path('/tmp/.X11-unix/X0')
        if not all(p.exists() and stat.S_ISSOCK(p.stat().st_mode) for p in [wayland, x11]):
            raise ValueError('wslg_display_unavailable')
        args += ['--perms', '0700', '--dir', '/run/user/1000',
                 '--ro-bind', str(wayland), '/run/user/1000/wayland-0',
                 '--tmpfs', '/tmp/.X11-unix', '--ro-bind', str(x11), '/tmp/.X11-unix/X0',
                 '--setenv', 'XDG_RUNTIME_DIR', '/run/user/1000',
                 '--setenv', 'WAYLAND_DISPLAY', 'wayland-0', '--setenv', 'DISPLAY', ':0',
                 '--setenv', 'STARPORT_WSLG_SHARED', '1']
    if seccomp_fd is not None:
        args += ['--seccomp', str(seccomp_fd)]
    return args + ['--', '/usr/bin/python3', '-I', '/opt/starport/guest-entry.py']


def serve(base=BASE, code=CODE):
    # A shared lease prevents a new workspace from racing an idle runtime or
    # package migration. The administrative parent retains it for the job.
    runtime_lease = open(code / 'runtime.lock', 'a')
    fcntl.flock(runtime_lease, fcntl.LOCK_SH | fcntl.LOCK_NB)
    first = sys.stdin.buffer.readline(96 * 1024 * 1024 + 1)
    if not first.endswith(b'\n') or len(first) > 96 * 1024 * 1024:
        raise ValueError('invalid_initial_frame')
    init = json.loads(first)
    workspace = prepare_workspace(base, init['workspace'])
    request = init['request']
    operation = request.get('operation')
    lock = open(workspace / ('files.lock' if operation == 'files' else 'native.lock' if operation == 'native' else 'run.lock'), 'a')
    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    if operation not in ['exec', 'files', 'native', 'sdk']:
        raise ValueError('invalid_operation')
    remote = operation == 'native' and request.get('display') in ('remote', 'seamless')
    if operation == 'native' and not remote and request.get('wslg') is not True:
        raise ValueError('wslg_authorization_required')
    if request['operation'] == 'exec':
        argv = request.get('argv')
        if not isinstance(argv, list) or not 1 <= len(argv) <= 64 or any(not isinstance(x, str) or '\0' in x or len(x) > 131072 for x in argv):
            raise ValueError('invalid_command')
    output = threading.Lock()
    peers, listeners = {}, []
    mutex = threading.Lock()
    stopped = threading.Event()
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

    def reader(number, channel, peer):
        try:
            send({'type': 'open', 'channel': channel, 'id': number})
            while not stopped.is_set():
                data = peer.recv(16384)
                if not data:
                    break
                send({'type': 'data', 'id': number, 'data': base64.b64encode(data).decode()})
        except OSError:
            pass
        finally:
            close(number)
            with contextlib.suppress(OSError):
                send({'type': 'close', 'id': number})

    def accept(listener, channel):
        nonlocal sequence
        while not stopped.is_set():
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
            peer.settimeout(None if channel == 'viewer' else 120)
            threading.Thread(target=reader, args=(number, channel, peer), daemon=True).start()

    with tempfile.TemporaryDirectory(prefix='starport-pipe-') as temporary:
        runtime = pathlib.Path(temporary)
        os.chmod(runtime, 0o755)
        for channel in ['proxy', 'model', 'compute'] + (['viewer'] if remote else []):
            listener = socket.socket(socket.AF_UNIX)
            listener.bind(str(runtime / (channel + '.sock')))
            os.chmod(runtime / (channel + '.sock'), 0o666)
            listener.listen(32)
            listeners.append(listener)
            threading.Thread(target=accept, args=(listener, channel), daemon=True).start()
        policy_fd = seccomp_filter(gui=operation == 'native')
        try:
            # bwrap maps the sandbox UID to its caller's real UID. Drop the
            # controller identity before exec, so UID 1000 also owns the private
            # project on the distribution side and never maps to host root.
            identity = {'user': UID, 'group': UID, 'extra_groups': ()} if os.geteuid() == 0 else {}
            child = subprocess.Popen(sandbox_args(workspace, runtime, code / 'etc', code / 'public', seccomp_fd=policy_fd, gui=operation == 'native', remote=remote, seamless=request.get('display')=='seamless'),
                                     stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, env={'PATH': '/usr/bin:/bin'},
                                     pass_fds=(policy_fd,), start_new_session=True, **identity)
        finally:
            os.close(policy_fd)
        child.stdin.write((json.dumps(request) + '\n').encode())
        child.stdin.flush()
        if operation != 'native':
            child.stdin.close()
        def stream(pipe, kind):
            while True:
                data = pipe.read1(8192)
                if not data:
                    break
                send({'type': 'output', 'stream': kind, 'data': base64.b64encode(data).decode()})
        streams = [threading.Thread(target=stream, args=(child.stdout, 'stdout'), daemon=True),
                   threading.Thread(target=stream, args=(child.stderr, 'stderr'), daemon=True)]
        for t in streams:
            t.start()
        send({'type': 'ready'})

        def input_frames():
            try:
                while True:
                    line = sys.stdin.buffer.readline(32769)
                    if not line:
                        break
                    if len(line) > 32768 or not line.endswith(b'\n'):
                        raise ValueError('invalid_frame')
                    f = json.loads(line)
                    if f.get('type') == 'native-action':
                        if operation != 'native' or f.get('app') not in ['browser', 'desktop', 'terminal', 'login', 'input-test', 'terminal-input-test', 'ime'] + (['viewer'] if remote else []):
                            raise ValueError('invalid_native_action')
                        message={'app': f['app']}
                        if f['app']=='ime':
                            if f.get('action') not in ['traditional','english','simplified','restart','settings'] or not isinstance(f.get('id'),str) or not re.fullmatch(r'[a-f0-9]{24}',f['id']):
                                raise ValueError('invalid_ime_action')
                            message.update(id=f['id'],action=f['action'])
                            if f['action']=='settings':message['settings']=f.get('settings')
                        child.stdin.write((json.dumps(message) + '\n').encode())
                        child.stdin.flush()
                        continue
                    n = f.get('id')
                    if type(n) is not int or n < 1:
                        raise ValueError('invalid_frame')
                    if f.get('type') == 'close':
                        close(n)
                    elif f.get('type') == 'data':
                        data = base64.b64decode(f.get('data', ''), validate=True)
                        if len(data) > 16384:
                            raise ValueError('invalid_frame')
                        with mutex:
                            peer = peers.get(n)
                        if peer:
                            try:
                                peer.sendall(data)
                            except OSError:
                                close(n)
                    else:
                        raise ValueError('invalid_frame')
            finally:
                stopped.set()
                # The operator pipe is gone: close egress immediately, then end only
                # this local process namespace. Remote jobs are not cancelled here.
                for n in list(peers):
                    close(n)
                if operation == 'native':
                    with contextlib.suppress(OSError):
                        child.stdin.close()
                    with contextlib.suppress(subprocess.TimeoutExpired):
                        child.wait(timeout=8)
                with contextlib.suppress(ProcessLookupError):
                    os.killpg(child.pid, signal.SIGTERM)
        input_thread = threading.Thread(target=input_frames, daemon=True)
        input_thread.start()
        result = child.wait()
        for t in streams:
            t.join(2)
        send({'type': 'exit', 'code': result})
        input_thread.join(2)
        stopped.set()
        for listener in listeners:
            listener.close()
        for n in list(peers):
            close(n)
        lock.close()


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('trusted_controller_requires_root')
        serve()
    except Exception:
        print(json.dumps({'type': 'failure', 'code': 'workspace_runner_failed'}), flush=True)
        sys.exit(1)
