# Adapted from Starport Pi tests (MIT). See THIRD_PARTY.md.
import base64
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import tarfile
import tempfile
import sys
import socket
import unittest
from unittest.mock import patch

if sys.platform != 'linux':
    reason = 'Linux worker tests require fcntl, sched_getaffinity and Linux file-descriptor semantics.'
    if __name__ == '__main__':
        print('SKIP: ' + reason)
        sys.exit(0)
    raise unittest.SkipTest(reason)

BASE=pathlib.Path(__file__).resolve().parents[1]
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
worker=module('worker',BASE/'packages/worker/worker.py')


class WorkerTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.temp.name)
        for d in ['workspaces','jobs','datasets','uploads']:(self.root/d).mkdir()
        self.cfg={'state':str(self.root),'cpu_indices':sorted(os.sched_getaffinity(0))[:2],'memory_gib':4,'gpu_indices':[],
            'egress_socket':str(self.root/'absent.sock')}
        self.wid=worker.dispatch(self.cfg,{'operation':'workspace.create'})['id'];self.ws=self.root/'workspaces'/self.wid
    def tearDown(self):self.temp.cleanup()
    def call(self,op,**args):return worker.dispatch(self.cfg,{'operation':op,'workspace':self.wid,**args})
    def test_unicode_and_scope(self):
        self.call('file.write',path='資料/文字.txt',content='繁體中文')
        r=self.call('file.read',path='資料/文字.txt');self.assertEqual(base64.b64decode(r['data']).decode(),'繁體中文')
        for value in ['../secret','/etc/passwd','a/../../b','C:\\file','a//b']:
            with self.assertRaises(ValueError):self.call('file.read',path=value)
    def test_links_and_special_files(self):
        outside=self.root/'secret';outside.write_text('private')
        (self.ws/'link').symlink_to(outside)
        with self.assertRaises(OSError):self.call('file.read',path='link')
        (self.ws/'dir').symlink_to(self.root,target_is_directory=True)
        with self.assertRaises(OSError):self.call('file.write',path='dir/secret',content='changed')
        self.assertEqual(outside.read_text(),'private')
        os.mkfifo(self.ws/'pipe')
        with self.assertRaises(ValueError):self.call('file.read',path='pipe')
    def test_immutable_dataset_and_link_rejection(self):
        self.call('file.write',path='data/a.txt',content='original');r=self.call('dataset.publish',path='data')
        self.call('file.write',path='data/a.txt',content='changed')
        self.assertEqual((self.root/'datasets'/r['id']/'payload/a.txt').read_text(),'original')
        (self.ws/'data/link').symlink_to('/etc/passwd')
        with self.assertRaises(ValueError):self.call('dataset.publish',path='data')
    def test_chunk_resume_checksum_and_finish_retry(self):
        body='文字'.encode()*100;h=hashlib.sha256(body).hexdigest()
        grant=self.call('upload.begin',path='assets/data.bin',bytes=len(body),sha256=h)
        chunk={'upload':grant['id'],'offset':0,'data':base64.b64encode(body).decode(),'sha256':h}
        self.call('upload.chunk',**chunk);self.call('upload.chunk',**chunk)
        result=self.call('upload.finish',upload=grant['id']);self.assertEqual(result['sha256'],h)
        self.assertEqual(self.call('upload.finish',upload=grant['id']),result)
        self.assertFalse((self.root/'uploads'/grant['id']/'content').exists())
        self.assertEqual((self.ws/'assets/data.bin').read_bytes(),body)
        # Simulate a process exit after the final rename but before its receipt.
        (self.root/'uploads'/grant['id']/'receipt.json').unlink()
        self.assertEqual(self.call('upload.finish',upload=grant['id']),result)
    def test_dead_controller_releases_only_its_own_job(self):
        with patch.object(worker.subprocess,'Popen') as process:
            process.return_value.pid=12345
            row=self.call('job.submit',command='true',cpus=1,memory_gib=1)
        record=self.root/'jobs'/row['id']/'status.json';state=worker.read_json(record)
        state['created_at']=0;state['controller_stamp']='old';worker.save(record,state)
        with patch.object(worker,'process_stamp',return_value='different'),patch.object(worker,'cleanup',return_value=True) as cleanup:
            worker.reconcile(self.cfg)
        self.assertEqual(cleanup.call_count,1)
        self.assertEqual(worker.read_json(record)['error'],'controller_interrupted')
        self.assertTrue(worker.read_json(record)['released'])
    def test_quiet_live_controller_is_never_reaped(self):
        with patch.object(worker.subprocess,'Popen') as process,patch.object(worker,'process_stamp',return_value='same'):
            process.return_value.pid=12345
            row=self.call('job.submit',command='sleep 3600',cpus=1,memory_gib=1)
        record=self.root/'jobs'/row['id']/'status.json';state=worker.read_json(record);state['created_at']=0;worker.save(record,state)
        with patch.object(worker,'process_stamp',return_value='same'),patch.object(worker,'cleanup') as cleanup:
            worker.reconcile(self.cfg)
        cleanup.assert_not_called();self.assertFalse(worker.read_json(record)['released'])
    def test_quota_and_workspace_reservations(self):
        with self.assertRaisesRegex(ValueError,'cpu_capacity'):self.call('job.submit',command='true',cpus=999)
        with self.assertRaisesRegex(ValueError,'gpu_driver'):self.call('job.submit',command='true',gpus=1)
        with patch.object(worker.subprocess,'Popen') as process:
            process.return_value.pid=12345
            r=self.call('job.submit',command='printf test',cpus=1,memory_gib=1)
            self.assertEqual(r['status'],'queued')
            self.assertNotIn('cpu_indices',r)
            with self.assertRaisesRegex(ValueError,'workspace_busy'):self.call('job.submit',command='true',cpus=1,memory_gib=1)
        other=worker.dispatch(self.cfg,{'operation':'workspace.create'})['id']
        with self.assertRaisesRegex(ValueError,'job_not_found'):worker.dispatch(self.cfg,{'operation':'job.cancel','workspace':other,'job':r['id']})
    def test_unknown_operator_fields_rejected(self):
        with self.assertRaisesRegex(ValueError,'unsupported_operation'):self.call('file.read',path='x',host='/')
        with self.assertRaisesRegex(ValueError,'unsupported_operation'):self.call('shell.local',command='true')

    def test_egress_recovery_removes_only_owned_refused_socket(self):
        p=pathlib.Path(self.cfg['egress_socket'])
        with socket.socket(socket.AF_UNIX) as s:
            s.bind(str(p));s.listen()
            with self.assertRaisesRegex(ValueError,'egress_already_owned'):worker.dispatch(self.cfg,{'operation':'egress.reset'})
        self.assertTrue(worker.dispatch(self.cfg,{'operation':'egress.reset'})['removed'])
        p.write_text('not a socket')
        with self.assertRaisesRegex(ValueError,'egress_ownership_mismatch'):worker.dispatch(self.cfg,{'operation':'egress.reset'})
        self.assertEqual(p.read_text(),'not a socket')

    def test_unlimited_parallel_still_checks_cpu_and_physical_memory(self):
        self.cfg.update(max_parallel=None,memory_gib=1600)
        with patch.object(worker,'memory_capacity_bytes',return_value=4*1024**3):
            with self.assertRaisesRegex(ValueError,'memory_capacity'):self.call('job.submit',command='true',cpus=1,memory_gib=5)
            with patch.object(worker.subprocess,'Popen') as process:
                process.return_value.pid=12345
                self.call('job.submit',command='true',cpus=1,memory_gib=1)
                self.wid=worker.dispatch(self.cfg,{'operation':'workspace.create'})['id']
                self.call('job.submit',command='true',cpus=1,memory_gib=1)
                self.wid=worker.dispatch(self.cfg,{'operation':'workspace.create'})['id']
                with self.assertRaisesRegex(ValueError,'cpu_capacity'):self.call('job.submit',command='true',cpus=1,memory_gib=1)



if __name__=='__main__':unittest.main()
