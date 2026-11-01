import importlib.util
import io
import pathlib
import sys
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('worker_install', pathlib.Path(__file__).resolve().parents[1] / 'packages/worker/install.py')
installer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(installer)

@unittest.skipUnless(sys.platform == 'linux', 'Linux archive ownership and no-follow operations')
class ArchiveTests(unittest.TestCase):
    def check_archive(self, members, should_fail):
        with tempfile.TemporaryDirectory() as folder:
            root = pathlib.Path(folder)
            archive = root / 'fixture.tar'
            with tarfile.open(archive, 'w') as tar:
                for name, content, link in members:
                    entry = tarfile.TarInfo(name)
                    if link is not None:
                        entry.type = tarfile.SYMTYPE
                        entry.linkname = link
                        tar.addfile(entry)
                    else:
                        entry.size = len(content)
                        tar.addfile(entry, io.BytesIO(content))
            target = root / 'extracted'; target.mkdir()
            if should_fail:
                with self.assertRaises((ValueError, OSError)):
                    installer.unpack(archive, target)
                self.assertFalse((root / 'escaped').exists())
            else:
                installer.unpack(archive, target)
                self.assertEqual((target / 'usr/bin/example').read_bytes(), b'example')

    def test_regular_files_and_guest_absolute_symlinks(self):
        self.check_archive([('usr/bin/example', b'example', None), ('bin', b'', '/usr/bin')], False)

    def test_traversal_duplicate_and_archive_link_parent_rejected(self):
        for members in [[('../escaped', b'x', None)], [('/escaped', b'x', None)],
                        [('same', b'a', None), ('same', b'b', None)],
                        [('escape', b'', '..'), ('escape/escaped', b'x', None)]]:
            self.check_archive(members, True)
