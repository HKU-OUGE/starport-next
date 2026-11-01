"""Trusted operator-only DSW byte transport; credentials never enter argv."""
import argparse
import json
import pathlib
import re
import subprocess
import sys

p = argparse.ArgumentParser()
p.add_argument('--config', required=True)
a = p.parse_args()
file = pathlib.Path(a.config).resolve()
c = json.loads(file.read_text())
if c['mode'] != 'dsw' or not re.fullmatch('dsw-[a-z0-9]{12,64}', c['instanceId']) or not re.fullmatch('[-a-z0-9]{2,50}', c['region']):
    raise SystemExit(1)
try:
    result = subprocess.run([str((file.parent/c['proxyClient']).resolve()), 'connect',
        '--region-id='+c['region'], '--instance-id='+c['instanceId'],
        '--config-file='+str((file.parent/c['credentialsFile']).resolve())],
        stdin=sys.stdin.buffer, stdout=sys.stdout.buffer, stderr=subprocess.DEVNULL)
    raise SystemExit(result.returncode)
except OSError:
    print('DSW transport unavailable; inspect the private operator configuration.', file=sys.stderr)
    raise SystemExit(1)
