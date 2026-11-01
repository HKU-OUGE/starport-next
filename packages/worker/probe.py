# Derived from Starport Pi (MIT), Copyright (c) 2026 Starport contributors.
# Maintained here as the standalone Starport Next worker. See THIRD_PARTY.md.
"""Run this inside the sandbox; output contains only the guest's public profile."""
import datetime
import json
import locale
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time


def probe():
    locale.setlocale(locale.LC_ALL, '')
    time.tzset()
    fonts = {}
    for name in ('sans-serif', 'serif', 'monospace'):
        fonts[name] = subprocess.check_output(
            ['fc-match', '-f', '%{family}', name + ':lang=zh-tw'], text=True).strip()
    direct = False
    try:
        connection = socket.create_connection(('1.1.1.1', 443), timeout=1)
        connection.close()
        direct = True
    except OSError:
        pass
    with tempfile.TemporaryDirectory() as folder:
        file = pathlib.Path(folder) / '臺灣文字測試.txt'
        file.write_text('繁體中文與 UTF-8', encoding='utf-8')
        roundtrip = file.read_text(encoding='utf-8') == '繁體中文與 UTF-8'
    checks = {
        'locale': locale.setlocale(locale.LC_ALL, None),
        'encoding': locale.getencoding(),
        'filesystem_encoding': sys.getfilesystemencoding(),
        'timezone': os.environ.get('TZ'),
        'offset_seconds': int(datetime.datetime.now().astimezone().utcoffset().total_seconds()),
        'fonts': fonts,
        'unicode_roundtrip': roundtrip,
        'machine_id_empty': pathlib.Path('/etc/machine-id').read_text() == '',
        'hostname': socket.gethostname(),
        'direct_network_blocked': not direct,
    }
    checks['passed'] = (checks['locale'] == 'zh_TW.UTF-8' and
        checks['encoding'].upper().replace('-', '') == 'UTF8' and
        checks['offset_seconds'] == 28800 and all('CJK TC' in v for v in fonts.values()) and
        roundtrip and checks['machine_id_empty'] and checks['hostname'] == 'workspace' and not direct)
    return checks


if __name__ == '__main__':
    result = probe()
    print(json.dumps(result, ensure_ascii=False))
    sys.exit(0 if result['passed'] else 1)
