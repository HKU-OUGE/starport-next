import base64
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

SOURCE = pathlib.Path(__file__).resolve().parents[1] / 'packages/wsl'


def load(name):
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), SOURCE / (name + '.py'))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


mcp, configure = load('compute-mcp'), load('configure-compute')


class ComputeMcpTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.compute = mcp.Compute(self.root)

    def test_stdio_initialize_discovery_and_notifications(self):
        messages = [{'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {'protocolVersion': '2025-06-18'}},
                    {'jsonrpc': '2.0', 'method': 'notifications/initialized'},
                    {'jsonrpc': '2.0', 'id': 2, 'method': 'tools/list'},
                    {'jsonrpc': '2.0', 'id': 3, 'method': 'tools/call', 'params': {'name': 'compute_guide', 'arguments': {}}}]
        p = subprocess.run([sys.executable, '-I', str(SOURCE / 'compute-mcp.py')], input='\n'.join(map(json.dumps, messages)) + '\n', capture_output=True, text=True, encoding='utf-8', timeout=10)
        self.assertEqual(p.returncode, 0)
        output = list(map(json.loads, p.stdout.splitlines()))
        self.assertEqual([x['id'] for x in output], [1, 2, 3])
        self.assertEqual(output[0]['result']['protocolVersion'], '2025-06-18')
        self.assertEqual(len(output[1]['result']['tools']), 8)
        self.assertIn('compute_submit', output[2]['result']['content'][0]['text'])
        self.assertEqual(p.stderr, '')

    def test_submit_inline_and_local_inputs_without_shell(self):
        (self.root / 'config.json').write_text('{}')
        with patch.object(self.compute, 'request', return_value={'id': 'a' * 32}) as request:
            result = self.compute.call('compute_submit', {'node': 'primary', 'entry': 'main.py', 'files': {'main.py': "print('ok')"}, 'local_files': ['config.json'], 'cpus': 1, 'gpus': 0, 'memory_gib': 2})
            self.assertEqual(result['id'], 'a' * 32)
            route, payload = request.call_args.args
            self.assertEqual(route, '/jobs')
            self.assertEqual(base64.b64decode(payload['files']['main.py']), b"print('ok')")
            self.assertNotIn('local_files', payload)
            self.assertEqual(payload['node'], 'primary')

    def test_invalid_inputs_never_reach_compute(self):
        with patch.object(self.compute, 'request') as request:
            for args in [{'entry': '../x', 'files': {'../x': 'x'}}, {'entry': 'x', 'files': {'x': 'x'}, 'ssh': 'host'},
                         {'entry': 'x', 'files': {'x': 'x'}, 'cpus': True}, {'entry': 'x', 'local_files': ['/home/agent/.claude.json']},
                         {'entry': 'missing', 'files': {'x': 'x'}}, {'entry': 'x', 'files': {'x': 'x'}, 'gpus': -1},
                         {'entry': 'x', 'files': {'x': 'x'}, 'node': '../host'}]:
                with self.assertRaises((ValueError, OSError)):
                    self.compute.call('compute_submit', args)
            request.assert_not_called()

    def test_download_proves_bytes_and_refuses_overwrite_or_escape(self):
        with patch.object(self.compute, 'request', return_value=b'verified\n') as request:
            args = {'job': 'a' * 32, 'artifact': 'out.txt', 'output': 'result.txt', 'include_text': True}
            result = self.compute.call('compute_download', args)
            self.assertEqual(result['text'], 'verified\n')
            self.assertEqual((self.root / 'result.txt').read_bytes(), b'verified\n')
            for changed in [{}, {'output': '../outside'}, {'artifact': '../../secret', 'output': 'new.txt'}]:
                with self.assertRaises(ValueError):
                    self.compute.call('compute_download', {**args, **changed})
            self.assertEqual(request.call_count, 1)

    def test_errors_do_not_expose_secrets_or_retry_unknown_submission(self):
        q = {'jsonrpc': '2.0', 'id': 1, 'method': 'tools/call', 'params': {'name': 'compute_health'}}
        with patch.object(self.compute, 'request', side_effect=RuntimeError('secret token: do-not-return')):
            response = mcp.dispatch(q, self.compute)
            self.assertTrue(response['result']['isError'])
            self.assertNotIn('do-not-return', json.dumps(response))
        q['params'] = {'name': 'compute_submit', 'arguments': {'entry': 'x.py', 'files': {'x.py': 'pass'}}}
        with patch.object(self.compute, 'request', side_effect=RuntimeError('compute_outcome_unknown_check_before_retry')) as request:
            response = mcp.dispatch(q, self.compute)
            self.assertIn('outcome_unknown', json.dumps(response))
            request.assert_called_once()

    def test_configuration_preserves_other_servers_instructions_and_refreshes_capability(self):
        project, home = self.root / 'project', self.root / 'home'
        project.mkdir(); home.mkdir()
        (project / 'CLAUDE.md').write_text('Keep my project rules.\n')
        (project / '.mcp.json').write_text(json.dumps({'mcpServers': {'existing': {'command': 'existing'}}, 'other': True}))
        with patch.dict(os.environ, {'STARPORT_COMPUTE_URL': 'http://127.0.0.1:18081', 'STARPORT_COMPUTE_TOKEN': 'a' * 64}):
            configure.configure(project, home, SOURCE)
            configure.configure(project, home, SOURCE)
        claude = (project / 'CLAUDE.md').read_text()
        self.assertIn('Keep my project rules.', claude)
        self.assertEqual(claude.count('@AGENTS.md'), 1)
        self.assertIn('compute_submit', (project / 'AGENTS.md').read_text(encoding='utf-8'))
        value = json.loads((project / '.mcp.json').read_text())
        self.assertEqual(value['mcpServers']['existing']['command'], 'existing')
        self.assertTrue(value['other'])
        self.assertNotIn('a' * 64, json.dumps(value))
        self.assertEqual(json.loads((home / '.config/Claude/claude_desktop_config.json').read_text())['mcpServers']['starport-compute'], configure.SERVER)
        cap = home / '.local/state/starport/compute-capability.json'
        with patch.dict(os.environ, {'STARPORT_COMPUTE_URL': 'http://127.0.0.1:18081', 'STARPORT_COMPUTE_TOKEN': 'b' * 64}):
            configure.configure(project, home, SOURCE)
        self.assertEqual(json.loads(cap.read_text())['token'], 'b' * 64)
        self.assertFalse(cap.with_name(cap.name + '.starport-before').exists())

    def test_conflicting_configuration_is_not_replaced(self):
        target = self.root / '.mcp.json'
        original = json.dumps({'mcpServers': {'starport-compute': {'command': 'user-server'}}})
        target.write_text(original)
        with self.assertRaisesRegex(ValueError, 'reconciliation'):
            configure.merge_server(target)
        self.assertEqual(target.read_text(), original)

    def test_unterminated_user_block_is_not_discarded(self):
        target = self.root / 'CLAUDE.md'
        original = '<!-- starport-compute -->\nMy own added rules\n'
        target.write_text(original)
        with self.assertRaisesRegex(ValueError, 'reconciliation'):
            configure.block(target, '@AGENTS.md')
        self.assertEqual(target.read_text(), original)


if __name__ == '__main__':
    unittest.main()
