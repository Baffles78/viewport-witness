import datetime
import pathlib
import tempfile
import unittest
from unittest.mock import Mock

from pilot_public_reply_notify import check, EXPIRES


class PublicReplyAlerts(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.state = pathlib.Path(self.tmp.name) / 'state.json'
        self.sent = []
        self.now = datetime.datetime(2026, 11, 23, tzinfo=datetime.timezone.utc)

    def run_check(self, ids):
        return check(self.state, lambda: ids, self.sent.append, self.now)

    def test_quiet_checks_and_unique_replies(self):
        self.run_check([])
        self.assertEqual(self.sent, [])
        self.run_check(['12', '12'])
        self.assertEqual(len(self.sent), 1)
        self.assertIn('identity and interest are unverified', self.sent[0])
        self.run_check(['12'])
        self.assertEqual(len(self.sent), 1)

    def test_failed_send_retries_without_losing_reply(self):
        with self.assertRaises(RuntimeError):
            check(self.state, lambda: ['12'], Mock(side_effect=RuntimeError()), self.now)
        self.run_check(['12'])
        self.assertEqual(len(self.sent), 1)

    def test_read_failures_alert_once_then_recover(self):
        for _ in range(2):
            with self.assertRaises(RuntimeError):
                check(self.state, Mock(side_effect=ValueError()), self.sent.append, self.now)
        self.assertEqual(len(self.sent), 1)
        self.run_check([])
        self.assertEqual(len(self.sent), 2)
        self.assertIn('recovered', self.sent[1])

    def test_expiry_does_not_read_or_send(self):
        fetch, sender = Mock(), Mock()
        self.assertEqual(check(self.state, fetch, sender, EXPIRES), {'expired': True})
        fetch.assert_not_called()
        sender.assert_not_called()


if __name__ == '__main__':
    unittest.main()
