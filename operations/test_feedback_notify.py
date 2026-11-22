import contextlib
import importlib.util
import json
import os
import pathlib
import sqlite3
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('feedback_notify', pathlib.Path(__file__).with_name('feedback_notify.py'))
notify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(notify)


class Notifications(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.database = pathlib.Path(self.tmp.name) / 'vw.db'
        self.state = pathlib.Path(self.tmp.name) / 'state.json'
        self.now = 1800000000
        self.sent = []
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute('CREATE TABLE feedback (id TEXT, created_at INTEGER, expires_at INTEGER, mode TEXT, body_json TEXT)')

    def insert(self, identity='one', mode='production', expires=None, **changes):
        body = {'product': 'extract', 'reason': 'missing_capability',
                'requestedChange': 'PDF export', 'purchaseIntent': 'not_stated'}
        body.update(changes)
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute('INSERT INTO feedback VALUES (?,?,?,?,?)',
                       (identity, int(self.now * 1000), int((self.now + 86400) * 1000) if expires is None else expires, mode, json.dumps(body)))

    def sender(self, text):
        self.sent.append(text)
        return True

    def check(self, **kwargs):
        return notify.check(self.database, self.state, self.sender, now=self.now, **kwargs)

    def test_quiet_when_empty_and_excludes_tests_and_expired(self):
        self.insert('test', mode='test')
        self.insert('testnet', mode='testnet')
        self.insert('expired', expires=int(self.now * 1000))
        self.assertEqual(self.check(), {'delivered': 0, 'waiting': 0})
        self.assertEqual(self.sent, [])

    def test_sends_once_and_survives_restarting_with_same_timestamp_rows(self):
        self.insert('one', maxPriceUsdc=0.02, purchaseIntent='considering')
        self.assertEqual(self.check()['delivered'], 1)
        self.assertIn('PDF export', self.sent[0])
        self.assertIn('0.02 USDC (not a payment)', self.sent[0])
        self.assertIn('Unverified', self.sent[0])
        self.assertEqual(self.check()['delivered'], 0)
        self.insert('two')  # Same timestamp, discovered without a lossy timestamp watermark.
        self.assertEqual(self.check()['delivered'], 1)
        self.assertEqual(len(self.sent), 2)

    def test_failure_preserves_durable_outbox_and_retries_without_skipping(self):
        self.insert()
        def failed(text):
            self.assertEqual(json.loads(self.state.read_text())['pending']['text'], text)
            raise RuntimeError('simulated delivery failure')
        with self.assertRaises(RuntimeError):
            notify.check(self.database, self.state, failed, now=self.now)
        state = json.loads(self.state.read_text())
        self.assertEqual(state['seen'], [])
        pending_text = state['pending']['text']
        self.assertEqual(self.check()['delivered'], 1)
        self.assertEqual(self.sent, [pending_text])
        self.assertIsNone(json.loads(self.state.read_text())['pending'])
        self.assertEqual(self.check()['delivered'], 0)

    def test_unacknowledged_delivery_never_advances(self):
        self.insert()
        with self.assertRaises(RuntimeError):
            notify.check(self.database, self.state, lambda text: False, now=self.now)
        self.assertEqual(json.loads(self.state.read_text())['seen'], [])

    def test_batch_backlog_is_bounded_and_drained(self):
        for index in range(23):
            self.insert(f'row-{index:02}')
        self.assertEqual(self.check(), {'delivered': 10, 'waiting': 13})
        self.assertEqual(self.check(), {'delivered': 10, 'waiting': 3})
        self.assertEqual(self.check(), {'delivered': 3, 'waiting': 0})
        self.assertEqual(self.check()['delivered'], 0)
        self.assertTrue(all(len(text) <= 3000 for text in self.sent))

    def test_expired_or_deleted_pending_feedback_is_not_forwarded(self):
        self.insert()
        with self.assertRaises(RuntimeError):
            notify.check(self.database, self.state, lambda text: False, now=self.now)
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            db.execute('DELETE FROM feedback')
        self.assertEqual(self.check()['delivered'], 0)
        self.assertEqual(self.sent, [])
        self.assertEqual(json.loads(self.state.read_text())['seen'], [])

    def test_corrupt_state_fails_closed_instead_of_resending_everything(self):
        self.insert()
        self.state.write_text('{broken')
        with self.assertRaises(ValueError):
            self.check()
        self.assertEqual(self.sent, [])

    def test_feedback_is_never_executed_or_rendered_as_telegram_markup(self):
        self.insert(requestedChange='<a href="https://example.com">click</a>')
        with self.assertRaises(ValueError):
            self.check()
        self.assertEqual(self.sent, [])
        self.assertFalse(self.state.exists())

    def test_database_is_opened_read_only(self):
        self.insert()
        original = notify.sqlite3.connect
        def readonly(database_uri, **kwargs):
            self.assertIn('?mode=ro', database_uri)
            connection = original(database_uri, **kwargs)
            with self.assertRaises(sqlite3.OperationalError):
                connection.execute('DELETE FROM feedback')
            return connection
        with patch.object(notify.sqlite3, 'connect', side_effect=readonly):
            self.check()
        with contextlib.closing(sqlite3.connect(self.database)) as db, db:
            self.assertEqual(db.execute('SELECT count(*) FROM feedback').fetchone()[0], 1)

    def test_telegram_ack_and_plain_text_payload(self):
        class Response:
            def __enter__(self): return self
            def __exit__(self, *args): pass
            def read(self, size): return json.dumps({'ok': True, 'result': {'message_id': 1, 'chat': {'id': 123}}}).encode()
        def transport(request, timeout):
            body = json.loads(request.data)
            self.assertNotIn('parse_mode', body)
            self.assertEqual(body['chat_id'], '123')
            self.assertTrue(body['disable_web_page_preview'])
            self.assertEqual(timeout, 20)
            return Response()
        with patch.dict(os.environ, TELEGRAM_BOT_TOKEN='fixture-only', TELEGRAM_AUTHORIZED_CHAT_ID='123'):
            with patch.object(notify.urllib.request, 'urlopen', side_effect=transport):
                self.assertTrue(notify.telegram_send('Fixture text'))
            with patch.object(notify.urllib.request, 'urlopen', side_effect=RuntimeError('https://api.telegram.org/botfixture-only/sendMessage')):
                with self.assertRaisesRegex(RuntimeError, '^TELEGRAM_DELIVERY_UNCONFIRMED$'):
                    notify.telegram_send('Fixture text')


if __name__ == '__main__':
    unittest.main()
