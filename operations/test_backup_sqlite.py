import importlib.util, pathlib, tempfile, sqlite3, os, shutil, unittest
s=importlib.util.spec_from_file_location('backup',pathlib.Path(__file__).with_name('backup_sqlite.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
class BackupTests(unittest.TestCase):
 def setUp(self):
  self.tmp=tempfile.TemporaryDirectory();self.root=pathlib.Path(self.tmp.name);self.key=self.root/'key';self.key.write_bytes(os.urandom(32));self.key.chmod(0o600);self.db=self.root/'source.db';self.live=sqlite3.connect(self.db);self.live.execute('pragma journal_mode=WAL');self.live.execute('create table jobs(id integer)');self.live.execute('insert into jobs values(7)');self.live.commit();self.work=self.root/'work';self.remote=self.root/'remote';self.calls=0
 def tearDown(self):self.live.close();self.tmp.cleanup()
 def transport(self,a,b):
  self.calls+=1
  if str(a).startswith('fixture:'):shutil.copyfile(self.remote,b)
  else:shutil.copyfile(a,self.remote)
 def run_backup(self,transport=None):return m.backup(self.db,self.work,self.key,'fixture:',transport or self.transport)
 def test_committed_wal_restores_and_does_not_mutate_source(self):
  receipt=self.run_backup();self.assertEqual(receipt['row_counts'],{'jobs':1});self.assertEqual(self.live.execute('select id from jobs').fetchone()[0],7);self.assertTrue(receipt['authenticated_decryption']);self.assertEqual(self.calls,2)
 def test_tampered_readback_preserves_previous_success(self):
  self.run_backup();before=(self.work/'latest-success.json').read_bytes()
  def tamper(a,b):
   self.transport(a,b)
   if str(a).startswith('fixture:'):
    p=pathlib.Path(b);raw=bytearray(p.read_bytes());raw[25]^=1;p.write_bytes(raw)
  with self.assertRaises(ValueError):self.run_backup(tamper)
  self.assertEqual((self.work/'latest-success.json').read_bytes(),before)
 def test_bad_key_fails_before_any_transfer(self):
  self.key.write_bytes(b'invalid')
  with self.assertRaises(ValueError):self.run_backup()
  self.assertEqual(self.calls,0)
 def test_corrupt_database_fails_without_offsite_success(self):
  self.live.close();self.db.write_bytes(b'not sqlite');self.live=sqlite3.connect(':memory:')
  with self.assertRaises(sqlite3.DatabaseError):self.run_backup()
  self.assertEqual(self.calls,0)
if __name__=='__main__':unittest.main()
