"""Merge compute configuration inside the project only; preserve unrelated settings."""
import json
import os
import pathlib
import tempfile

BEGIN = '<!-- starport-compute -->'
END = '<!-- /starport-compute -->'
SERVER = {'command': '/usr/bin/python3', 'args': ['-I', '/opt/starport/compute-mcp.py']}


def safe(path):
    for p in [path, *path.parents]:
        if p.is_symlink():
            raise ValueError('compute_configuration_symlink_refused')
    return path


def write(path, content):
    safe(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    if path.is_file() and path.read_text(encoding='utf-8') == content:
        return
    # Keep one previous version for the user; capability files are excluded.
    if path.is_file() and path.name != 'compute-capability.json':
        backup = safe(path.with_name(path.name + '.starport-before'))
        if not backup.exists():
            with backup.open('x', encoding='utf-8') as f:
                f.write(path.read_text(encoding='utf-8'))
            backup.chmod(0o600)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.starport-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8', newline='\n') as f:
            f.write(content)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def merge_server(path):
    value = json.loads(safe(path).read_text()) if path.exists() else {}
    servers = value.setdefault('mcpServers', {})
    if not isinstance(servers, dict):
        raise ValueError('invalid_existing_mcp_config')
    if 'starport-compute' in servers and servers['starport-compute'] != SERVER:
        raise ValueError('existing_compute_server_requires_reconciliation')
    servers['starport-compute'] = SERVER
    write(path, json.dumps(value, ensure_ascii=False, indent=2) + '\n')


def block(path, content):
    old = safe(path).read_text(encoding='utf-8') if path.exists() else ''
    managed = BEGIN + '\n' + content.rstrip() + '\n' + END
    if BEGIN in old:
        prefix, tail = old.split(BEGIN, 1)
        if END in tail:
            _, suffix = tail.split(END, 1)
        elif tail.strip() == 'For remote CPU/GPU tasks, read /workspace/STARPORT_COMPUTE.md and use /workspace/starport_compute.py through Bash. Only submit within the user-requested resource budget.':
            suffix = ''  # Migrate the exact legacy generated block, never arbitrary user text.
        else:
            raise ValueError('compute_instruction_block_requires_reconciliation')
        value = prefix + managed + suffix
    else:
        value = old.rstrip() + '\n\n' + managed + '\n'
    write(path, value.lstrip('\n') if not old else value)


def configure(workspace=pathlib.Path('/workspace'), home=pathlib.Path('/home/agent'), source=pathlib.Path(__file__).parent):
    os.umask(0o077)
    url, token = os.environ.get('STARPORT_COMPUTE_URL'), os.environ.get('STARPORT_COMPUTE_TOKEN')
    if url != 'http://127.0.0.1:18081' or not token or len(token) < 32:
        raise ValueError('project_compute_capability_required')
    guide = (source / 'COMPUTE-AGENT.md').read_text(encoding='utf-8')
    merge_server(workspace / '.mcp.json')
    merge_server(home / '.config/Claude/claude_desktop_config.json')
    block(workspace / 'AGENTS.md', guide)
    block(workspace / 'CLAUDE.md', '@AGENTS.md')
    write(workspace / 'STARPORT_COMPUTE.md', guide)
    write(home / '.local/state/starport/compute-capability.json', json.dumps({'url': url, 'token': token}))
    return {'configured': True, 'mcpServer': 'starport-compute', 'tools': 8, 'accountLoginVerified': False}


if __name__ == '__main__':
    try:
        print(json.dumps(configure()))
    except Exception:
        raise SystemExit('compute_client_configuration_failed')
