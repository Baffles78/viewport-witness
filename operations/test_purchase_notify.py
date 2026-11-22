import contextlib
import hashlib
import json
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch
import purchase_notify as notice


class PurchaseAlerts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = pathlib.Path(self.tmp.name)
        self.db = self.root / 'db.sqlite'
        self.state = self.root / 'state' / 'state.json'
        self.controlled = self.root / 'controlled'
        self.controlled.mkdir()
        self.now = 1800000000
        self.sent = []
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.executescript('CREATE TABLE quickstart_meta(key TEXT,value INTEGER); '
                             'INSERT INTO quickstart_meta VALUES("started_at",1); '
                             'CREATE TABLE quickstart_jobs(job_id TEXT,customer_id TEXT,source TEXT,created_at INTEGER,paid_at INTEGER);')

    def insert(self, job='real', payer='payer', source='agent-client', paid=True, age=0):
        customer = 'cust_' + hashlib.sha256(payer.encode()).hexdigest() if payer else None
        created = int((self.now - age) * 1000)
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO quickstart_jobs VALUES(?,?,?,?,?)',
                       (job, customer, source, created, created if paid else None))

    def sender(self, text):
        self.sent.append(text)
        return True

    def check(self, **options):
        return notice.check(self.db, self.state, self.controlled, options.get('sender', self.sender), now=self.now)

    def exclude(self, *ids):
        (self.controlled / 'tests.json').write_text(json.dumps({
            'excludeFromExternalDemand': True, 'controlledJobIds': list(ids)}))

    def test_baseline_quiet_new_payer_once_repeat_and_restart_quiet(self):
        self.insert('old', 'old-payer')
        self.assertTrue(self.check()['baseline'])
        self.assertEqual(self.sent, [])
        self.insert()
        self.assertEqual(self.check()['delivered'], 1)
        self.insert('repeat')
        self.assertEqual(self.check()['delivered'], 0)
        self.assertEqual(len(self.sent), 1)
        self.assertIn('Production USDC payment accepted', self.sent[0])
        self.assertNotIn('cust_', self.sent[0])

    def test_excludes_monitors_tests_controlled_pending_unknown_and_missing_identity(self):
        self.check()
        self.insert('monitor', 'm', 'monitor')
        self.insert('test', 't', 'test-client')
        self.insert('controlled', 'same-payer')
        self.insert('pending', 'p', paid=False)
        self.insert('unattributed', payer=None)
        self.exclude('controlled')
        self.assertEqual(self.check()['delivered'], 0)
        self.insert('external', 'same-payer', 'mcp')
        self.assertEqual(self.check()['delivered'], 1)

    def test_failure_durable_retry_then_rechecks_new_exclusion(self):
        self.check()
        self.insert()
        def fail(text):
            self.assertEqual(json.loads(self.state.read_text())['pending']['text'], text)
            raise RuntimeError('not delivered')
        with self.assertRaises(RuntimeError):
            self.check(sender=fail)
        self.exclude('real')
        self.assertEqual(self.check()['delivered'], 0)
        self.assertEqual(self.sent, [])
        self.assertIsNone(json.loads(self.state.read_text())['pending'])

    def test_retry_delivers_and_seen_survives_ledger_expiry(self):
        self.check()
        self.insert()
        with self.assertRaises(RuntimeError):
            self.check(sender=lambda _: False)
        self.assertEqual(self.check()['delivered'], 1)
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('DELETE FROM quickstart_jobs')
        self.check()
        self.insert('later')
        self.assertEqual(self.check()['delivered'], 0)

    def test_broken_ledger_or_incomplete_history_never_sends_or_advances(self):
        self.check()
        self.insert()
        before = self.state.read_bytes()
        (self.controlled / 'bad.json').write_text('{bad')
        with self.assertRaises(ValueError):
            self.check()
        self.assertEqual(before, self.state.read_bytes())
        (self.controlled / 'bad.json').unlink()
        with contextlib.closing(sqlite3.connect(self.db)) as db, db:
            db.execute('INSERT INTO quickstart_meta VALUES("write_failures",1)')
        with self.assertRaises(ValueError):
            self.check()
        self.assertEqual(self.sent, [])

    def test_same_timestamp_batching_and_bounded_messages(self):
        self.check()
        for n in range(12):
            self.insert(str(n), str(n))
        self.assertEqual(self.check(), {'delivered': 10, 'waiting': 2})
        self.assertEqual(self.check(), {'delivered': 2, 'waiting': 0})
        self.assertTrue(all(len(text) < 1000 for text in self.sent))

    def test_telegram_transport_uses_existing_secret_safe_sender(self):
        with patch.dict('os.environ', {'TELEGRAM_BOT_TOKEN': 'test-secret', 'TELEGRAM_AUTHORIZED_CHAT_ID': '123'}), patch('feedback_notify.urllib.request.urlopen', side_effect=RuntimeError('test-secret')):
            with self.assertRaisesRegex(RuntimeError, '^TELEGRAM_DELIVERY_UNCONFIRMED$'):
                notice.telegram_send('setup')


if __name__ == '__main__':
    unittest.main()
