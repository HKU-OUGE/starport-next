"""Trusted display client, with neutral files/environment and no IP networking.

Only the X11/XWayland display and one owned Unix transport are visible. Project
programs never receive the host display socket, authority, HOME or clipboard.
"""
import argparse
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import tempfile


def build_command(socket, etc, home, authority, display):
    if not re.fullmatch(r':[0-9]+(?:\.[0-9]+)?', display):
        raise ValueError('local_x11_or_xwayland_required')
    screen = display.split('.')[0][1:]
    x11 = Path('/tmp/.X11-unix') / ('X' + screen)
    if not stat.S_ISSOCK(x11.stat().st_mode):
        raise ValueError('local_display_unavailable')
    command = ['/usr/bin/bwrap', '--unshare-all', '--die-with-parent', '--new-session',
               '--hostname', 'starport-viewer', '--uid', '1000', '--gid', '1000',
               '--cap-drop', 'ALL', '--clearenv', '--ro-bind', '/usr', '/usr']
    for name in ('bin', 'sbin', 'lib', 'lib64'):
        p = Path('/') / name
        if p.is_symlink():
            command += ['--symlink', os.readlink(p), '/' + name]
        elif p.exists():
            command += ['--ro-bind', str(p), '/' + name]
    command += ['--ro-bind', str(etc), '/etc', '--bind', str(home), '/home/viewer',
                '--proc', '/proc', '--tmpfs', '/proc/sys', '--dev', '/dev', '--dir', '/sys',
                '--tmpfs', '/tmp', '--dir', '/tmp/.X11-unix', '--dir', '/run/display',
                '--ro-bind', str(x11), str(x11), '--ro-bind', str(authority), '/run/display/Xauthority',
                '--dir', '/run/bridge', '--ro-bind', str(socket), '/run/bridge/xpra.sock',
                '--dir', '/opt/starport-viewer', '--ro-bind', str(Path(__file__).with_name('xpra-entry.py')), '/opt/starport-viewer/entry.py']
    environment = {'HOME': '/home/viewer', 'USER': 'viewer', 'LOGNAME': 'viewer',
                   'PATH': '/usr/bin:/bin', 'LANG': 'C.UTF-8', 'TZ': 'Asia/Taipei',
                   'DISPLAY': display, 'XAUTHORITY': '/run/display/Xauthority', 'GDK_BACKEND': 'x11',
                   'LIBGL_ALWAYS_SOFTWARE': '1', 'XPRA_FULL_INFO': '0'}
    for key, value in environment.items():
        command += ['--setenv', key, value]
    command += ['--', '/usr/bin/python3', '/opt/starport-viewer/entry.py', 'attach', 'socket:/run/bridge/xpra.sock',
                '--clipboard=no', '--file-transfer=no', '--printing=no', '--open-files=no',
                '--open-url=no', '--speaker=disabled', '--microphone=disabled', '--webcam=no',
                '--notifications=no', '--system-tray=no', '--opengl=no', '--tray=no',
                '--username=viewer', '--keyboard-layout=us', '--dpi=96', '--desktop-scaling=off', '--remote-logging=no', '--mmap=no', '--xsettings=no']
    return command


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--socket', required=True)
    args = parser.parse_args()
    socket = Path(args.socket)
    st = socket.lstat()
    if socket.is_symlink() or not stat.S_ISSOCK(st.st_mode) or st.st_uid != os.getuid() or st.st_mode & 0o077:
        raise ValueError('owned_viewer_socket_required')
    display = os.environ.get('DISPLAY', '')
    authority = Path(os.environ.get('XAUTHORITY', str(Path.home() / '.Xauthority')))
    if not authority.is_file() or authority.stat().st_uid != os.getuid():
        raise ValueError('display_authority_required')
    with tempfile.TemporaryDirectory(prefix='starport-viewer-') as temporary:
        root = Path(temporary)
        etc, home = root / 'etc', root / 'home'
        etc.mkdir(); home.mkdir()
        for name, content in {
            'passwd': 'viewer:x:1000:1000:viewer:/home/viewer:/bin/false\n',
            'group': 'viewer:x:1000:\n', 'hosts': '127.0.0.1 localhost starport-viewer\n',
            'hostname': 'starport-viewer\n', 'resolv.conf': 'nameserver 127.0.0.1\n',
            'nsswitch.conf': 'passwd: files\ngroup: files\nhosts: files\n',
            'machine-id': '00000000000000000000000000000001\n', 'timezone': 'Asia/Taipei\n',
        }.items():
            (etc / name).write_text(content)
        shutil.copyfile('/usr/share/zoneinfo/Asia/Taipei', etc / 'localtime')
        if Path('/etc/fonts').is_dir():
            shutil.copytree('/etc/fonts', etc / 'fonts', symlinks=False)
        result = subprocess.run(build_command(socket, etc, home, authority, display))
        return result.returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except (OSError, ValueError):
        raise SystemExit('seamless_display_unavailable')
