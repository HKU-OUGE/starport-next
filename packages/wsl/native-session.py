"""Project-side WSLg supervisor; Windows display/clipboard sharing is explicit."""
import json
import os
import pathlib
import shutil
import subprocess
import sys
import threading
import time

if os.environ.get('STARPORT_WSLG_SHARED') != '1':
    raise SystemExit('wslg_authorization_required')
os.umask(0o077)
os.environ['CLAUDE_CONFIG_DIR'] = '/home/agent/.claude-account'
os.environ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
os.environ['BROWSER'] = '/usr/local/bin/starport-browser'
os.environ['ELECTRON_OZONE_PLATFORM_HINT'] = 'wayland'
os.environ['XDG_SESSION_TYPE'] = 'wayland'
os.environ['GSK_RENDERER'] = 'cairo'
os.environ['LIBGL_ALWAYS_SOFTWARE'] = '1'
for directory in ['.config', '.local/share/applications', '.local/state/starport', '.claude-account']:
    (pathlib.Path('/home/agent') / directory).mkdir(parents=True, exist_ok=True)
# Refresh the project capability at each native session. Desktop may launch MCP
# with a restricted environment; no API key or management secret is persisted.
subprocess.run(['/usr/bin/python3', '-I', '/opt/starport/configure-compute.py'],
               check=True, stdout=subprocess.DEVNULL)
# A private session bus, never the distribution or Windows user's bus.
bus = subprocess.run(['/usr/bin/dbus-daemon','--session','--fork','--print-address=1','--print-pid=1'], capture_output=True, text=True, check=True)
os.environ['DBUS_SESSION_BUS_ADDRESS'] = bus.stdout.splitlines()[0]
pathlib.Path('/home/agent/.config/mimeapps.list').write_text('[Default Applications]\nx-scheme-handler/http=starport-browser.desktop\nx-scheme-handler/https=starport-browser.desktop\n')
apps = {}
output_lock = threading.Lock()

def report():
    with output_lock:
        print(json.dumps({'kind': 'native_state', 'apps': {
            name: 'running' if child.poll() is None else 'stopped' for name, child in apps.items()
        }}), flush=True)

def launch(name):
    if name in apps and apps[name].poll() is None:
        return
    commands = {
        'browser': ['/usr/local/bin/starport-browser', 'https://claude.ai/'],
        'desktop': ['/usr/bin/claude-desktop', '--proxy-server=http://127.0.0.1:13128',
                    '--proxy-bypass-list=localhost;127.0.0.1;[::1]', '--disable-quic', '--disable-gpu'],
        'terminal': ['/usr/bin/xterm', '-T', 'Starport / Claude Code', '-fa', 'monospace', '-fs', '12', '-e', '/bin/bash', '--noprofile', '--norc', '-c', 'claude; exec bash --noprofile --norc'],
        'login': ['/usr/bin/xterm', '-T', 'Starport / Claude Code Login', '-fa', 'monospace', '-fs', '12', '-e', '/bin/bash', '--noprofile', '--norc', '-c', 'claude auth login --claudeai; printf "\\nPress Enter to close."; read -r ignored'],
    }
    if name not in commands:
        raise ValueError('invalid_native_app')
    # Diagnostics stay in the private project HOME; authentication URLs and tokens
    # must never be included in control-plane status or repository receipts.
    with open('/home/agent/.local/state/starport/' + name + '.log', 'w') as log:
        apps[name] = subprocess.Popen(commands[name], stdin=subprocess.DEVNULL,
                                      stdout=log, stderr=log,
                                      cwd='/workspace', start_new_session=True)
    report()

def monitor():
    while True:
        time.sleep(2)
        report()

print(json.dumps({'kind': 'native_ready'}), flush=True)
threading.Thread(target=monitor, daemon=True).start()
try:
    for line in sys.stdin:
        launch(json.loads(line)['app'])
finally:
    for child in apps.values():
        if child.poll() is None:
            child.terminate()
    for child in apps.values():
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
