"""Project-side WSLg supervisor; Windows display/clipboard sharing is explicit."""
import json
import importlib.util
import os
import pathlib
import shutil
import socket
import stat
import subprocess
import sys
import threading
import time

remote = os.environ.get('STARPORT_REMOTE_DISPLAY') == '1'
seamless = os.environ.get('STARPORT_SEAMLESS_DISPLAY') == '1'
if not remote and os.environ.get('STARPORT_WSLG_SHARED') != '1':
    raise SystemExit('wslg_authorization_required')
os.umask(0o077)
os.environ['CLAUDE_CONFIG_DIR'] = '/home/agent/.claude-account'
os.environ['CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC'] = '1'
os.environ['BROWSER'] = '/usr/local/bin/starport-browser'
os.environ['ELECTRON_OZONE_PLATFORM_HINT'] = 'x11'
os.environ['XDG_SESSION_TYPE'] = 'x11'
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
display_processes = []
output_lock = threading.Lock()

if remote:
    # This project holds native.lock; no previous GUI namespace is alive. Xvfb
    # leaves its lock in the persistent project tmp when that namespace exits.
    lockfile=pathlib.Path('/tmp/.X1-lock')
    if lockfile.exists() or lockfile.is_symlink():
        info=lockfile.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid!=os.getuid():
            raise SystemExit('display_lock_ownership_unknown')
        lockfile.unlink()
    # RFB is bound only inside this network namespace. No host port or desktop
    # is exported. The authenticated controller requests each viewer connection.
    log = open('/home/agent/.local/state/starport/display.log', 'w')
    if seamless:
        pathlib.Path('/run/user/1000/xpra').mkdir(mode=0o700,exist_ok=True)
        # Xpra owns a private X server here. No host display, D-Bus, file transfer,
        # clipboard, URL launching or arbitrary remote commands are available.
        display_processes.append(subprocess.Popen([
            '/usr/bin/python3', '-c', "import runpy; from PIL import Image; Image.ANTIALIAS=getattr(Image,'ANTIALIAS',Image.Resampling.LANCZOS); runpy.run_path('/usr/bin/xpra',run_name='__main__')", 'start', ':1', '--daemon=no', '--bind-tcp=127.0.0.1:14500',
            '--tcp-auth=none', '--socket-dir=/run/user/1000/xpra', '--html=off', '--mdns=no',
            '--clipboard=no', '--file-transfer=no', '--printing=no', '--open-files=no',
            '--open-url=no', '--speaker=disabled', '--microphone=disabled', '--webcam=no',
            '--notifications=no', '--system-tray=no', '--dbus-proxy=no', '--pulseaudio=no', '--xsettings=no',
            '--start-new-commands=no', '--exit-with-client=no', '--sharing=no',
            '--xvfb=/usr/bin/Xvfb -nolisten tcp -noreset -screen 0 1920x1080x24 +extension Composite -ac'],
            stdin=subprocess.DEVNULL,stdout=log,stderr=log))
    else:
        display_processes.append(subprocess.Popen([
            '/usr/bin/Xtigervnc', ':1', '-geometry', '1440x900', '-depth', '24',
            '-localhost', '-rfbport', '5901', '-SecurityTypes', 'None', '-ac',
            '-nolisten', 'tcp', '-nolock', '-SendCutText=1', '-AcceptCutText=1',
            '-MaxCutText=1048576'], stdin=subprocess.DEVNULL, stdout=log, stderr=log))
    for _ in range(200):
        if display_processes[0].poll() is not None:
            raise SystemExit('remote_display_start_failed')
        if pathlib.Path('/tmp/.X11-unix/X1').exists():
            break
        time.sleep(0.05)
    else:
        raise SystemExit('remote_display_start_timeout')
    if not seamless:
        display_processes.append(subprocess.Popen(['/usr/bin/openbox','--sm-disable'],stdin=subprocess.DEVNULL,stdout=log,stderr=log))



spec = importlib.util.spec_from_file_location('starport_ime', '/opt/starport/ime.py')
ime_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ime_module)
ime = ime_module.InputMethod()
os.environ.update(ime.environment_for_apps())
ime.start()

def connect_viewer():
    def forward():
        local, control = None, None
        try:
            deadline=time.monotonic()+8
            while True:
                try:
                    local=socket.create_connection(('127.0.0.1', 14500 if seamless else 5901),timeout=1)
                    break
                except OSError:
                    if time.monotonic()>=deadline or display_processes[0].poll() is not None:
                        raise
                    time.sleep(0.05)
            local.settimeout(None)
            control = socket.socket(socket.AF_UNIX)
            control.connect('/run/bridge/viewer.sock')
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
                        dst.shutdown(socket.SHUT_RDWR)
                    except OSError:
                        pass
            worker = threading.Thread(target=pump, args=(local, control), daemon=True)
            worker.start()
            pump(control, local)
        except OSError:
            pass
        finally:
            if local:
                local.close()
            if control:
                control.close()
    threading.Thread(target=forward, daemon=True).start()

def report(ime_state=None):
    with output_lock:
        print(json.dumps({'kind': 'native_state', 'ime': ime_state if ime_state is not None else ime.status(), 'apps': {
            name: 'running' if child.poll() is None else 'stopped' for name, child in apps.items()
        }}), flush=True)

def launch(name):
    if name == 'viewer' and remote:
        connect_viewer()
        return
    if name in apps and apps[name].poll() is None:
        return
    # The remote X server otherwise defaults to white, while Claude uses a dark
    # theme. Pin Latin cell metrics too: the locale's CJK monospace fallback can
    # make ASCII terminal text appear double-spaced.
    terminal = ['/usr/bin/xterm', '-u8', '-class', 'StarportTerminal', '-xrm', '*openIm: true', '-fa', 'DejaVu Sans Mono', '-fs', '12',
                '-bg', '#1e1e1e', '-fg', '#d4d4d4', '-cr', '#d4d4d4']
    commands = {
        'browser': ['/usr/local/bin/starport-browser', 'https://claude.ai/'],
        'input-test': ['/usr/local/bin/starport-browser', 'file:///opt/starport/ime-check.html'],
        'terminal-input-test': terminal + ['-T', 'Starport / Input test', '-e', '/usr/bin/python3', '-I', '-c',
                               'import json\nprint("Offline input test: English first; Ctrl+Space for Chinese. Enter echoes text; no commands run.")\nwhile True:\n try: print(json.dumps(input("input> "),ensure_ascii=False))\n except (EOFError,KeyboardInterrupt): break'],
        'desktop': ['/usr/bin/claude-desktop', '--proxy-server=http://127.0.0.1:13128',
                    '--proxy-bypass-list=localhost;127.0.0.1;[::1]', '--disable-quic', '--disable-gpu'],
        'terminal': terminal + ['-T', 'Starport / Claude Code', '-e', '/bin/bash', '--noprofile', '--norc', '-c', 'claude; exec bash --noprofile --norc'],
        'login': terminal + ['-T', 'Starport / Claude Code Login', '-e', '/bin/bash', '--noprofile', '--norc', '-c', 'claude auth login --claudeai; printf "\\nPress Enter to close."; read -r ignored'],
    }
    if name not in commands:
        raise ValueError('invalid_native_app')
    if name in ('browser','input-test') and shutil.which('google-chrome-stable'):
        commands[name].insert(1, '--ozone-platform=x11')
    if name == 'desktop':
        commands[name].append('--ozone-platform=x11')
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
        report(ime.tick())

print(json.dumps({'kind': 'native_ready', 'ime': ime.status(query=False)}), flush=True)
threading.Thread(target=monitor, daemon=True).start()
try:
    for line in sys.stdin:
        message = json.loads(line)
        if message['app'] == 'ime':
            result = {'kind':'native_ime_result','id':message['id']}
            try:
                result['ime'] = ime.action(message['action'], message.get('settings'))
            except (ValueError, OSError, subprocess.TimeoutExpired) as exc:
                code = str(exc)
                result['error'] = code if code.startswith('ime_') or code.startswith('invalid_ime_') else 'ime_action_failed'
            with output_lock:
                print(json.dumps(result), flush=True)
            report()
        else:
            launch(message['app'])
finally:
    ime.stop()
    for child in [*apps.values(), *display_processes]:
        if child.poll() is None:
            child.terminate()
    for child in [*apps.values(), *display_processes]:
        try:
            child.wait(timeout=3)
        except subprocess.TimeoutExpired:
            child.kill()
