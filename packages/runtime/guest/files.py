import base64, hashlib, json, os, pathlib, sys, tempfile

ROOT = pathlib.Path('/workspace')
LIMIT = 64 * 1024 * 1024

def target(value):
    if not isinstance(value, str) or '\\' in value or '\x00' in value:
        raise ValueError('invalid_project_path')
    parts = value.split('/') if value else []
    if any(p in ('', '.', '..') for p in parts):
        raise ValueError('invalid_project_path')
    p = ROOT
    for part in parts:
        p = p / part
        if p.is_symlink():
            raise ValueError('project_symlink_rejected')
    if not p.resolve().is_relative_to(ROOT):
        raise ValueError('project_path_outside_workspace')
    return p

def main(q):
    p = target(q.get('path', ''))
    op = q['operation']
    if op == 'list':
        if not p.is_dir(): raise ValueError('not_a_directory')
        entries = sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name))
        offset = q.get('offset', 0)
        if type(offset) is not int or offset < 0: raise ValueError('invalid_offset')
        return {'entries': [{'name': x.name, 'directory': x.is_dir(), 'symlink': x.is_symlink(),
                             'bytes': x.lstat().st_size} for x in entries[offset:offset + 500]],
                'nextOffset': offset + 500 if len(entries) > offset + 500 else None}
    if op == 'read':
        if not p.is_file(): raise ValueError('file_not_found')
        if p.stat().st_size > LIMIT: raise ValueError('file_transfer_limit')
        data = p.read_bytes()
        return {'data': base64.b64encode(data).decode(), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data)}
    if op == 'write':
        data = base64.b64decode(q['data'], validate=True)
        if len(data) > LIMIT or hashlib.sha256(data).hexdigest() != q['sha256']:
            raise ValueError('file_integrity_mismatch')
        if p == ROOT or not p.parent.is_dir(): raise ValueError('destination_parent_required')
        if p.exists() and not q.get('replace', False): raise ValueError('file_exists')
        fd, tmp = tempfile.mkstemp(prefix='.starport-upload-', dir=p.parent)
        try:
            with os.fdopen(fd, 'wb') as f:
                f.write(data); f.flush(); os.fsync(f.fileno())
            if q.get('replace', False): os.replace(tmp, p)
            else: os.link(tmp, p)
        finally:
            if os.path.exists(tmp): os.unlink(tmp)
        return {'written': True, 'sha256': q['sha256'], 'bytes': len(data)}
    if op == 'mkdir':
        p.mkdir(mode=0o700)
        return {'created': True}
    if op == 'rename':
        dest = target(q['destination'])
        if p == ROOT or dest.exists(): raise ValueError('destination_exists')
        p.rename(dest)
        return {'renamed': True}
    if op == 'delete':
        if p == ROOT: raise ValueError('workspace_root_protected')
        if p.is_dir(): p.rmdir()
        else: p.unlink()
        return {'deleted': True}
    raise ValueError('unsupported_file_operation')

try:
    raw = sys.stdin.buffer.read(LIMIT * 2 + 1)
    if len(raw) > LIMIT * 2: raise ValueError('request_too_large')
    print(json.dumps(main(json.loads(raw))))
except Exception as exc:
    code = str(exc) if isinstance(exc, ValueError) else 'project_file_operation_failed'
    print(json.dumps({'error': code})); sys.exit(1)
