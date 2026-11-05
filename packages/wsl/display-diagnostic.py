"""Read-only operator probe for one owned WSL project's disappearing windows.

Never returns command lines, URLs, environment values, raw logs or host identity.
This probe is not installed in, or callable by, the model's project boundary.
"""
import datetime
import json
import os
from pathlib import Path
import re
import sys


def requested_ozone(argv):
    mode = 'unspecified'
    for i, arg in enumerate(argv):
        value = arg.split('=', 1)[1] if arg.startswith('--ozone-platform=') else argv[i+1] if arg == '--ozone-platform' and i+1 < len(argv) else None
        if value is not None:
            mode = value if value in ('x11', 'wayland', 'auto') else 'other'
    return mode


def log_signals(file):
    try:
        if any(p.is_symlink() for p in [file, *file.parents]):
            return {'available': False}
        st = file.stat()
        with file.open('rb') as stream:
            stream.seek(max(0, st.st_size - 65536))
            text = stream.read(65536).decode('utf8', errors='replace').lower()
    except OSError:
        return {'available': False}
    return {'available': True, 'modifiedAt': datetime.datetime.fromtimestamp(st.st_mtime, datetime.timezone.utc).isoformat(),
            'displayDisconnect': bool(re.search(r'wayland.*(?:disconnect|connection.*(?:broken|reset|closed))|x connection.*broken|connection to .*lost|rdp.*disconnect', text)),
            'displayError': bool(re.search(r'(?:wayland|weston|xwayland).*(?:fatal|error|assertion)|failed to connect to.*display', text)),
            'memorySignal': bool(re.search(r'out of memory|oom-kill|cannot allocate memory', text))}


def collect(request, *, base=Path('/var/lib/starport-workspaces'), code=Path('/opt/starport-wsl'), proc=Path('/proc'), wslg=Path('/mnt/wslg')):
    workspace, owner = request.get('workspace'), request.get('owner')
    if not isinstance(workspace, str) or not re.fullmatch('[a-z][a-z0-9-]{0,47}', workspace):
        raise ValueError('invalid_workspace')
    if not isinstance(owner, str) or not re.fullmatch('[a-f0-9]{64}', owner) or (code/'owner').is_symlink() or (code/'owner').read_text().strip() != owner:
        raise ValueError('owned_wsl_required')
    directory = base/workspace
    if base.is_symlink() or directory.is_symlink() or (directory/'project').is_symlink():
        raise ValueError('invalid_workspace_root')
    target = (directory/'project').stat()
    browsers, native = [], []
    for p in proc.iterdir():
        if not p.name.isdigit():
            continue
        try:
            st = (p/'root/workspace').stat()
            if (st.st_dev, st.st_ino) != (target.st_dev, target.st_ino):
                continue
            argv = (p/'cmdline').read_bytes()[:65536].decode('utf8', errors='replace').rstrip('\0').split('\0')
            executable = Path(argv[0]).name
            # stat field 22: use the final ')' because the process name may contain spaces.
            start = int((p/'stat').read_text().rsplit(')', 1)[1].split()[19])
            if executable == 'python3' and '/opt/starport/guest-entry.py' in argv:
                native.append({'pid': int(p.name), 'startTicks': start})
            if executable in ('chrome', 'google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser') and not any(v == '--type' or v.startswith('--type=') for v in argv):
                browsers.append({'pid': int(p.name), 'startTicks': start, 'requestedOzone': requested_ozone(argv)})
        except (OSError, ValueError, IndexError):
            continue
    def socket_exists(file):
        import stat
        try:
            return stat.S_ISSOCK(file.stat().st_mode)
        except OSError:
            return False
    version = None
    try:
        match = re.search(r'WSLg[^\n]*?([0-9]+\.[0-9]+\.[0-9]+)', (wslg/'versions.txt').read_text(errors='replace')[:8192])
        if match:
            version = match[1]
    except OSError:
        pass
    return {'workspace': workspace, 'nativeSessions': sorted(native, key=lambda x: x['pid']),
            'browsers': sorted(browsers, key=lambda x: x['pid']), 'wslgVersion': version,
            'displaySockets': {'wayland': socket_exists(wslg/'runtime-dir/wayland-0'), 'x11': socket_exists(wslg/'.X11-unix/X0')},
            'logSignals': {name: log_signals(wslg/name) for name in ('weston.log', 'wlog.log', 'stderr.log')},
            'browserLogSignals': log_signals(directory/'home/.local/state/starport/browser.log'),
            'logSignalsAreNotACauseDiagnosis': True}


if __name__ == '__main__':
    try:
        if os.geteuid() != 0:
            raise ValueError('operator_diagnostic_requires_root')
        print(json.dumps(collect(json.loads(sys.stdin.readline(8192))), separators=(',', ':')))
    except Exception as exc:
        error = str(exc) if isinstance(exc, ValueError) and re.fullmatch('[a-z_]+', str(exc)) else 'display_diagnostic_failed'
        print(json.dumps({'error': error}))
        sys.exit(1)
