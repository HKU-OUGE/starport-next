set -eu
python3 - <<'PY'
import json, pathlib, socket
p = pathlib.Path('result.json')
p.write_text(json.dumps({'sum': sum(range(101)), 'hostname': socket.gethostname()}))
print(p.read_text())
PY
