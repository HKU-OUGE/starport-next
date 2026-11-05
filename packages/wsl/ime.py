"""Project-owned offline input method. No host bus, input history or cloud IME."""
import hashlib
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import threading
import time

SCHEMAS = {'traditional': 'starport_pinyin_tw', 'simplified': 'starport_pinyin_simp'}
HOTKEYS = {'Control+space', 'Control+Shift+space', 'Control+Alt+space'}
DEFAULTS = {'hotkey': 'Control+space', 'rememberWindows': True}


def preferences(value):
    if not isinstance(value, dict) or set(value) - set(DEFAULTS):
        raise ValueError('invalid_ime_settings')
    result = {**DEFAULTS, **value}
    if result['hotkey'] not in HOTKEYS or not isinstance(result['rememberWindows'], bool):
        raise ValueError('invalid_ime_settings')
    return result


def configuration(settings):
    settings = preferences(settings)
    files = {'config/fcitx5/config': '''[Hotkey]
EnumerateWithTriggerKeys=False
[Hotkey/TriggerKeys]
[Hotkey/AltTriggerKeys]
[Hotkey/EnumerateForwardKeys]
[Hotkey/EnumerateBackwardKeys]
[Hotkey/EnumerateGroupForwardKeys]
[Hotkey/EnumerateGroupBackwardKeys]
[Hotkey/ActivateKeys]
[Hotkey/DeactivateKeys]
[Behavior]
ActiveByDefault=True
ShareInputState=No
PreeditEnabledByDefault=True
AllowInputMethodForPassword=False
ShowPreeditForPassword=False
''', 'config/fcitx5/profile': '''[Groups/0]
Name=Default
Default Layout=us
DefaultIM=rime
[Groups/0/Items/0]
Name=keyboard-us
Layout=
[Groups/0/Items/1]
Name=rime
Layout=
[GroupOrder]
0=Default
''', 'config/fcitx5/conf/rime.conf': 'InputState='+('No' if settings['rememberWindows'] else 'All')+'\nPreeditMode=ComposingText\nCommit when deactivate=False\n',
        'config/fcitx5/conf/classicui.conf': 'Vertical Candidate List=False\nFont=Noto Sans CJK TC 12\nShowLayoutNameInIcon=False\n',
        'config/fcitx5/conf/xcb.conf': 'AllowOverridingSystemXkb=False\n',
        'data/fcitx5/rime/default.custom.yaml': '''patch:
  schema_list:
    - schema: starport_pinyin_tw
    - schema: starport_pinyin_simp
  switcher/save_options: []
  menu/page_size: 5
''', 'data/fcitx5/rime/fcitx5.custom.yaml': '''patch:
  app_options:
    xterm: {ascii_mode: true}
    StarportTerminal: {ascii_mode: true}
'''}
    for mode, identifier in SCHEMAS.items():
        converter = 't2tw.json' if mode == 'traditional' else 't2s.json'
        label = '繁體拼音' if mode == 'traditional' else '简体拼音'
        files['data/fcitx5/rime/' + identifier + '.schema.yaml'] = f'''__include: luna_pinyin.schema:/
schema:
  schema_id: {identifier}
  name: {label}
  version: "1.0"
__patch:
  switches:
    - {{name: ascii_mode, reset: 0, states: [中文, English]}}
    - {{name: full_shape, reset: 0, states: [半角, 全角]}}
    - {{name: ascii_punct, reset: 1, states: [中文標點, ASCII]}}
    - {{name: starport_conversion, reset: 1}}
  engine/filters: [simplifier@starport_output, uniquifier]
  starport_output:
    option_name: starport_conversion
    opencc_config: {converter}
    tips: none
  key_binder/bindings:
    - {{when: always, accept: {settings['hotkey']}, toggle: ascii_mode}}
  translator/enable_user_dict: false
  custom_phrase/enable_user_dict: false
'''
    return files


def atomic(file, value):
    file.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    if file.is_symlink():
        raise ValueError('ime_configuration_symlink')
    target = file.with_name(file.name + '.' + secrets.token_hex(8) + '.tmp')
    with target.open('x', encoding='utf8') as out:
        os.chmod(target, 0o600)
        out.write(value)
    target.replace(file)


def configuration_hash(name, value):
    if name.startswith('config/fcitx5/'):
        # Fcitx adds comments and blank lines when saving its profile. These
        # changes are not user edits; preserve the rendered file on restart.
        value = '\n'.join(line.strip() for line in value.splitlines()
                          if line.strip() and not line.lstrip().startswith('#'))
    return hashlib.sha256(value.encode()).hexdigest()


def prepare(home):
    root = Path(home) / '.local/share/starport-ime'
    if root.is_symlink():
        raise ValueError('ime_configuration_symlink')
    root.mkdir(parents=True, mode=0o700, exist_ok=True)
    prefs = root / 'preferences.json'
    settings = preferences(json.loads(prefs.read_text()) if prefs.exists() else {})
    marker = root / 'managed.json'
    old = json.loads(marker.read_text()) if marker.exists() else {}
    new = {}
    for name, value in configuration(settings).items():
        file = root / name
        # Never overwrite locally edited configuration or follow parent symlinks.
        for parent in [file, *file.parents]:
            if parent == root.parent:
                break
            if parent.is_symlink():
                raise ValueError('ime_configuration_symlink')
        expected = configuration_hash(name, value)
        if file.exists():
            current = configuration_hash(name, file.read_text())
            if current != expected and current != old.get(name) and hashlib.sha256(file.read_bytes()).hexdigest() != old.get(name):
                raise ValueError('ime_configuration_changed')
        if not file.exists() or configuration_hash(name, file.read_text()) != expected:
            atomic(file, value)
        new[name] = expected
    atomic(marker, json.dumps(new))
    atomic(prefs, json.dumps(settings))
    return root, settings


class InputMethod:
    def __init__(self, home='/home/agent', environment=None):
        self.home = Path(home)
        self.environment = dict(environment or os.environ)
        self.root = self.home / '.local/share/starport-ime'
        self.child = None
        self.lock = threading.RLock()
        self.phase = 'not_started'
        self.error = None
        self.settings = dict(DEFAULTS)
        self.xim = 'starport-ime-' + secrets.token_hex(8)
        self.restart_times = []
        self.next_attempt = 0

    def environment_for_apps(self):
        return {'GTK_IM_MODULE': 'fcitx', 'QT_IM_MODULE': 'fcitx',
                'XMODIFIERS': '@im=' + self.xim, 'SDL_IM_MODULE': 'fcitx',
                'ELECTRON_OZONE_PLATFORM_HINT': 'x11', 'XDG_SESSION_TYPE': 'x11',
                'GDK_BACKEND': 'x11', 'QT_QPA_PLATFORM': 'xcb', 'MOZ_ENABLE_WAYLAND': '0'}

    def call(self, method, *args, rime=False):
        # Query the bus itself first. Calling an absent well-known name would
        # auto-start the distribution's unconfigured Fcitx before our child has
        # claimed it, losing this project's XIM name and private configuration.
        owner = subprocess.run(['/usr/bin/gdbus', 'call', '--session', '--dest',
                                'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus',
                                '--method', 'org.freedesktop.DBus.NameHasOwner', 'org.fcitx.Fcitx5'],
                               env=self.environment, capture_output=True, text=True, timeout=3)
        if owner.returncode or owner.stdout.strip() != '(true,)':
            raise ValueError('ime_bus_unavailable')
        route, interface = ('/rime', 'org.fcitx.Fcitx.Rime1') if rime else ('/controller', 'org.fcitx.Fcitx.Controller1')
        result = subprocess.run(['/usr/bin/gdbus', 'call', '--session', '--dest', 'org.fcitx.Fcitx5',
                                 '--object-path', route, '--method', interface + '.' + method, *args],
                                env=self.environment, capture_output=True, text=True, timeout=3)
        if result.returncode:
            raise ValueError('ime_bus_unavailable')
        return result.stdout.strip()

    def start(self, timeout=45):
        with self.lock:
            self.error = None
            if self.child and self.child.poll() is None:
                return self.status()
            self.child = None
            if not all(shutil.which(name) for name in ['fcitx5', 'gdbus']):
                self.phase, self.error = 'unavailable', 'ime_not_installed'
                return self.status(query=False)
            try:
                self.root, self.settings = prepare(self.home)
                env = {**self.environment, **self.environment_for_apps(),
                       'XDG_CONFIG_HOME': str(self.root / 'config'),
                       'XDG_DATA_HOME': str(self.root / 'data'), 'XDG_CACHE_HOME': str(self.root / 'cache'),
                       'FCITX_NO_PRELOAD': '0'}
                # X11 frontend only; never take over the compositor's global IME.
                env.pop('WAYLAND_DISPLAY', None)
                disabled = 'wayland,waylandim,clipboard,cloudpinyin,notifications,notificationitem'
                with (self.root / 'service.log').open('w') as log:
                    os.chmod(self.root / 'service.log', 0o600)
                    self.child = subprocess.Popen(['fcitx5', '--disable=' + disabled], env=env,
                                                  stdin=subprocess.DEVNULL, stdout=log, stderr=log)
                self.phase = 'preparing'
                deadline = time.monotonic() + timeout
                while time.monotonic() < deadline:
                    if self.child.poll() is not None:
                        raise ValueError('ime_process_exited')
                    try:
                        schemas = self.call('ListAllSchemas', rime=True)
                        if all(identifier in schemas for identifier in SCHEMAS.values()):
                            self.phase = 'ready'
                            return self.status()
                    except (OSError, ValueError, subprocess.TimeoutExpired):
                        pass
                    time.sleep(0.2)
                self.error = 'ime_dictionary_preparing'
            except (OSError, ValueError, subprocess.TimeoutExpired) as exc:
                self.phase = 'failed'
                code = str(exc)
                self.error = code if re.fullmatch(r'ime_[a-z_]+', code) else 'ime_start_failed'
            return self.status(query=False)

    def status(self, query=True):
        with self.lock:
            return self._status(query)

    def _status(self, query):
        mode = None
        if self.child and self.child.poll() is not None:
            self.phase, self.error = 'failed', 'ime_process_exited'
        if query and self.child and self.child.poll() is None:
            try:
                schemas = self.call('ListAllSchemas', rime=True)
                if all(identifier in schemas for identifier in SCHEMAS.values()):
                    self.phase, self.error = 'ready', None
                    current = self.call('GetCurrentSchema', rime=True)
                    if self.call('IsAsciiMode', rime=True) == '(true,)':
                        mode = 'english'
                    else:
                        mode = next((name for name, identifier in SCHEMAS.items() if identifier in current), None)
            except (OSError, ValueError, subprocess.TimeoutExpired):
                self.phase, self.error = 'reconnecting', 'ime_bus_unavailable'
        return {'phase': self.phase, 'mode': mode, 'defaultChinese': 'traditional',
                'available': ['traditional', 'english', 'simplified'],
                'hotkey': self.settings['hotkey'], 'rememberWindows': self.settings['rememberWindows'], 'error': self.error}

    def action(self, action, settings=None):
        with self.lock:
            if action in ('traditional', 'simplified', 'english'):
                if self.phase != 'ready':
                    raise ValueError('ime_not_ready')
                if self.call('GetCurrentSchema', rime=True) in ("('',)", '("",)'):
                    raise ValueError('ime_focus_required')
                # Rime scopes these methods to its most recent input context.
                if action != 'english':
                    self.call('SetSchema', SCHEMAS[action], rime=True)
                self.call('SetAsciiMode', 'true' if action == 'english' else 'false', rime=True)
            elif action == 'restart':
                self.stop()
                self.start()
            elif action == 'settings':
                values = preferences(settings)
                atomic(self.root / 'preferences.json', json.dumps(values))
                self.stop()
                self.start()
            else:
                raise ValueError('invalid_ime_action')
            return self.status()

    def tick(self):
        with self.lock:
            value = self.status()
            if value['phase'] == 'failed' and self.error == 'ime_process_exited':
                now = time.monotonic()
                self.restart_times = [t for t in self.restart_times if now - t < 60]
                if now >= self.next_attempt and len(self.restart_times) < 3:
                    self.restart_times.append(now)
                    self.next_attempt = now + 5
                    return self.start(timeout=5)
            return value

    def stop(self):
        with self.lock:
            child = self.child
            if child and child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait(timeout=2)
            self.child = None
            self.phase = 'stopped'
