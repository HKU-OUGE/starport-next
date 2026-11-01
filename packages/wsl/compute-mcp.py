"""Project-scoped stdio MCP; no operator transport or credentials in this process."""
import base64
import hashlib
import json
import os
import pathlib
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

MAX_INPUT = 24 * 1024 * 1024
ROOT = pathlib.Path('/workspace')
CAPABILITY = pathlib.Path('/home/agent/.local/state/starport/compute-capability.json')
GUIDE = pathlib.Path(__file__).with_name('COMPUTE-AGENT.md').read_text(encoding='utf-8')


def obj(properties=None, required=None):
    return {'type': 'object', 'properties': properties or {}, 'required': required or [], 'additionalProperties': False}


STRING = {'type': 'string'}
JOB = {'type': 'string', 'pattern': '^[a-f0-9]{32}$'}


def tool(name, description, schema, readonly=False, idempotent=False):
    return {'name': name, 'description': description, 'inputSchema': schema,
            'annotations': {'readOnlyHint': readonly, 'destructiveHint': name == 'compute_cancel',
                            'idempotentHint': readonly or idempotent, 'openWorldHint': False}}


TOOLS = [
    tool('compute_guide', 'Read the project remote-compute workflow and constraints before submitting a task.', obj(), True),
    tool('compute_health', 'List servers by node ID, readiness and individual CPU/GiB/GPU limits. Inspect nodes before submission; aggregate capacity cannot be requested as one job.', obj(), True),
    tool('compute_jobs', 'List this project\'s jobs, including unknown submissions. Reconcile before any retry.', obj(), True),
    tool('compute_submit', 'Submit ONE remote isolated Python/Bash job. Returns a job ID; save it immediately. Never retry an unknown outcome. Inputs appear in remote /workspace; write artifacts under /output. No SSH or host execution.',
         obj({'entry': STRING, 'node': {'type': 'string', 'pattern': '^[a-z][a-z0-9-]{0,47}$'}, 'files': {'type': 'object', 'additionalProperties': STRING},
              'local_files': {'type': 'array', 'items': STRING, 'maxItems': 16},
              'args': {'type': 'array', 'items': STRING, 'maxItems': 128},
              'language': {'type': 'string', 'enum': ['python', 'bash']},
              'cpus': {'type': 'integer', 'minimum': 1}, 'memory_gib': {'type': 'integer', 'minimum': 1},
              'gpus': {'type': 'integer', 'minimum': 0}, 'timeout': {'type': 'integer', 'minimum': 1}}, ['entry'])),
    tool('compute_status', 'Poll one job and inspect resources_released, exit_code and artifact names.', obj({'job': JOB}, ['job']), True),
    tool('compute_logs', 'Read remote task logs from a byte cursor; returns the next cursor.', obj({'job': JOB, 'cursor': {'type': 'integer', 'minimum': 0}}, ['job']), True),
    tool('compute_cancel', 'Cancel the specified project job. Poll status afterwards to confirm resources were released.', obj({'job': JOB}, ['job']), idempotent=True),
    tool('compute_download', 'Download a finished job artifact into a new project-relative file. Refuses overwrites and path escapes. Optionally return up to 64 KiB of UTF-8 text for verification.',
         obj({'job': JOB, 'artifact': STRING, 'output': STRING, 'include_text': {'type': 'boolean'}}, ['job', 'artifact', 'output'])),
]


def validate(value, schema):
    kind = schema.get('type')
    types = {'object': dict, 'array': list, 'string': str, 'integer': int, 'boolean': bool}
    if kind in types and (not isinstance(value, types[kind]) or kind == 'integer' and isinstance(value, bool)):
        raise ValueError('invalid_tool_arguments')
    if kind == 'object':
        props = schema.get('properties', {})
        if any(k not in value for k in schema.get('required', [])):
            raise ValueError('invalid_tool_arguments')
        for key, item in value.items():
            rule = props.get(key, schema.get('additionalProperties', False))
            if rule is False:
                raise ValueError('unsupported_tool_argument')
            if isinstance(rule, dict):
                validate(item, rule)
    if kind == 'array':
        if len(value) > schema.get('maxItems', 128):
            raise ValueError('too_many_items')
        for item in value:
            validate(item, schema['items'])
    if kind == 'integer' and value < schema.get('minimum', 0):
        raise ValueError('invalid_tool_arguments')
    if 'enum' in schema and value not in schema['enum'] or 'pattern' in schema and not re.fullmatch(schema['pattern'], value):
        raise ValueError('invalid_tool_arguments')


def relative(name):
    if not isinstance(name, str) or not name or len(name) > 512 or any(ord(c) < 32 for c in name) or '\\' in name:
        raise ValueError('project_relative_path_required')
    p = pathlib.PurePosixPath(name)
    if p.is_absolute() or any(x in ('', '.', '..') for x in name.split('/')):
        raise ValueError('project_relative_path_required')
    return p


def project_file(root, name):
    p = root.joinpath(relative(name))
    current = root
    for part in relative(name).parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('project_symlink_not_allowed')
    if not p.resolve().is_relative_to(root.resolve()):
        raise ValueError('project_relative_path_required')
    return p


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        raise RuntimeError('compute_redirect_denied')


class Compute:
    def __init__(self, root=ROOT, capability=CAPABILITY):
        self.root = root
        self.capability = capability

    def request(self, route, body=None, binary=False):
        token = os.environ.get('STARPORT_COMPUTE_TOKEN')
        url = os.environ.get('STARPORT_COMPUTE_URL')
        if not token or not url:
            value = json.loads(self.capability.read_text())
            token, url = value['token'], value['url']
        u = urllib.parse.urlsplit(url)
        if u.scheme != 'http' or u.hostname != '127.0.0.1' or not u.port or u.username or u.password or u.path not in ('', '/') or u.query or u.fragment or len(token) < 32:
            raise ValueError('project_compute_capability_required')
        request = urllib.request.Request(url.rstrip('/') + route, data=None if body is None else json.dumps(body).encode(),
                                         headers={'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json'})
        try:
            with urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect()).open(request, timeout=210) as response:
                data = response.read()
        except urllib.error.HTTPError as e:
            try:
                message = json.loads(e.read()).get('error', 'compute_request_failed')
            except Exception:
                message = 'compute_request_failed'
            raise RuntimeError(message) from None
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            raise RuntimeError('compute_unavailable' if body is None else 'compute_outcome_unknown_check_before_retry') from None
        return data if binary else json.loads(data)

    def call(self, name, args):
        definition = next((t for t in TOOLS if t['name'] == name), None)
        if not definition:
            raise ValueError('unknown_compute_tool')
        validate(args, definition['inputSchema'])
        if name == 'compute_guide':
            return {'guide': GUIDE}
        if name in ('compute_health', 'compute_jobs'):
            return self.request('/' + name.removeprefix('compute_'))
        if name == 'compute_submit':
            files = {}
            for key, value in args.get('files', {}).items():
                files[str(relative(key))] = value.encode('utf-8')
            for key in args.get('local_files', []):
                if key in files:
                    raise ValueError('duplicate_job_file')
                p = project_file(self.root, key)
                if not p.is_file() or p.stat().st_size > 16 * 1024 * 1024:
                    raise ValueError('invalid_job_file')
                files[key] = p.read_bytes()
            if not 1 <= len(files) <= 16 or sum(map(len, files.values())) > 16 * 1024 * 1024 or args['entry'] not in files:
                raise ValueError('invalid_job_files')
            payload = {k: v for k, v in args.items() if k not in ('files', 'local_files')}
            payload['files'] = {k: base64.b64encode(v).decode() for k, v in files.items()}
            return self.request('/jobs', payload)
        route = '/jobs/' + args['job']
        if name == 'compute_status':
            return self.request(route)
        if name == 'compute_logs':
            return self.request(route + '/logs?cursor=' + str(args.get('cursor', 0)))
        if name == 'compute_cancel':
            return self.request(route + '/cancel', {})
        output = project_file(self.root, args['output'])
        if output.exists():
            raise ValueError('output_already_exists')
        artifact = str(relative(args['artifact']))
        data = self.request(route + '/artifact/' + urllib.parse.quote(artifact, safe='/'), binary=True)
        # The HTTP bridge verifies each remote chunk's hash and immutable version.
        with output.open('xb') as f:
            f.write(data)
        result = {'saved': args['output'], 'bytes': len(data), 'sha256': hashlib.sha256(data).hexdigest()}
        if args.get('include_text'):
            try:
                result['text'] = data[:65536].decode('utf-8')
                result['textTruncated'] = len(data) > 65536
            except UnicodeDecodeError:
                result['textUnavailable'] = 'artifact_is_not_utf8'
        return result


def dispatch(q, compute):
    if not isinstance(q, dict) or q.get('jsonrpc') != '2.0' or not isinstance(q.get('method'), str):
        return {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32600, 'message': 'invalid_request'}}
    if 'id' not in q:
        return None
    response = {'jsonrpc': '2.0', 'id': q['id']}
    method, params = q['method'], q.get('params', {})
    if method == 'initialize':
        supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25', '2026-07-28']
        version = params.get('protocolVersion')
        response['result'] = {'protocolVersion': version if version in supported else '2025-06-18',
                              'capabilities': {'tools': {}}, 'serverInfo': {'name': 'starport-compute', 'version': '1.0.0'}, 'instructions': GUIDE}
    elif method == 'ping':
        response['result'] = {}
    elif method == 'tools/list':
        response['result'] = {'tools': TOOLS}
    elif method == 'tools/call':
        try:
            result = compute.call(params.get('name'), params.get('arguments', {}))
            response['result'] = {'content': [{'type': 'text', 'text': json.dumps(result, ensure_ascii=False)}]}
        except Exception as e:
            message = str(e)
            response['result'] = {'isError': True, 'content': [{'type': 'text', 'text': json.dumps({'error': message if re.fullmatch('[a-z][a-z0-9_]{1,79}', message) else 'compute_tool_failed'})}]}
    else:
        response['error'] = {'code': -32601, 'message': 'method_not_found'}
    return response


def main():
    sys.stdout.reconfigure(encoding='utf-8')
    compute = Compute()
    while True:
        line = sys.stdin.buffer.readline(MAX_INPUT + 1)
        if not line:
            return
        if len(line) > MAX_INPUT:
            return
        try:
            q = json.loads(line)
            response = dispatch(q, compute)
        except (ValueError, TypeError, AttributeError):
            response = {'jsonrpc': '2.0', 'id': None, 'error': {'code': -32700, 'message': 'parse_error'}}
        if response is not None:
            print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
