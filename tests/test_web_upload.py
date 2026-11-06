import base64
import hashlib
import importlib.util
import pathlib
import tempfile
import unittest
from unittest.mock import patch

REPO = pathlib.Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location('web_mcp', REPO / 'packages/wsl/web-mcp.py')
web = importlib.util.module_from_spec(spec); spec.loader.exec_module(web)
guest = {}
exec((REPO / 'packages/runtime/guest/files.py').read_text(encoding='utf-8').split('\ntry:\n')[0], guest)


class WebUpload(unittest.TestCase):
    def test_public_urls_only(self):
        self.assertEqual(web.public_url('https://example.com/test#fragment'), 'https://example.com/test')
        for url in ['file:///etc/passwd', 'http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost', 'https://169.254.169.254', 'https://0177.0.0.1', 'https://0x7f000001', 'https://service.internal', 'https://user:pass@example.com', 'https://example.com:18884', 'https://example.com\n']:
            with self.subTest(url=url), self.assertRaises(ValueError):
                web.public_url(url)

    def test_no_local_fetch_and_errors_are_not_success(self):
        body = web.request_body({'url': 'https://example.com'}, 'configured-model')
        self.assertEqual(body['model'], 'configured-model')
        self.assertEqual(body['tools'][0]['name'], 'web_fetch')
        self.assertNotIn('tool_choice', body)  # Current Opus rejects forced tool selection.
        error = web.extract({'content': [{'type': 'web_fetch_tool_result', 'content': {'type': 'web_fetch_tool_result_error', 'error_code': 'url_not_allowed'}}]})
        self.assertEqual(error['errors'], ['url_not_allowed']); self.assertEqual(error['pages'], [])
        with patch.dict(web.os.environ, {'ANTHROPIC_BASE_URL': 'https://bad.example.com', 'STARPORT_WEB_MODEL': 'm', 'ANTHROPIC_API_KEY': 'example'}):
            with self.assertRaisesRegex(ValueError, 'project_model_gateway_required'):
                web.call({'url': 'https://example.com'})

    def test_pdf_binary_not_echoed_and_usage_preserved(self):
        result = web.extract({'content': [{'type': 'web_fetch_tool_result', 'content': {'type': 'web_fetch_result', 'url': 'https://example.com/a.pdf', 'content': {'source': {'type': 'base64', 'media_type': 'application/pdf', 'data': 'PRIVATE_BINARY'}}}}, {'type': 'text', 'text': 'Summary'}], 'usage': {'input_tokens': 10}})
        self.assertIsNone(result['pages'][0]['text']); self.assertEqual(result['usage']['input_tokens'], 10)
        self.assertNotIn('PRIVATE_BINARY', str(result)); self.assertEqual(result['errors'], [])

    def test_upload_retry_and_separate_same_name_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            guest['ROOT'] = pathlib.Path(tmp)
            data = '中文data'.encode(); digest = hashlib.sha256(data).hexdigest()
            q = {'operation': 'attach', 'session': 'a'*32, 'id': '12345678-1234-1234-1234-123456789abc', 'name': '数据.txt', 'data': base64.b64encode(data).decode(), 'sha256': digest}
            self.assertEqual(guest['main'](q)['sha256'], digest)
            self.assertEqual(guest['main'](q)['sha256'], digest)
            other = {**q, 'id': '12345678-1234-1234-1234-123456789def'}
            guest['main'](other)
            self.assertEqual(len(list(pathlib.Path(tmp).rglob('数据.txt'))), 2)
            target = next(pathlib.Path(tmp).rglob('数据.txt')); target.write_text('changed')
            changed = q if q['id'] in str(target) else other
            with self.assertRaisesRegex(ValueError, 'attachment_content_changed'):
                guest['main'](changed)
            with self.assertRaises(ValueError):
                guest['main']({**q, 'name': '../escape'})


if __name__ == '__main__':
    unittest.main()
