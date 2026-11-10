#!/usr/bin/env python3
"""Run: python3 operations/test_error_watch.py"""
import os, sys, tempfile, unittest
from unittest import mock
sys.path.insert(0, os.path.dirname(__file__))
import error_watch as w

OK_PROBES = {r: (402, 3633) for r in w.PAID_ROUTES}


class FindProblems(unittest.TestCase):
    def test_all_clear(self):
        self.assertEqual(w.find_problems('healthy', [], OK_PROBES), [])

    def test_unhealthy_errors_and_bad_routes(self):
        probes = dict(OK_PROBES, verify=(500, 100), compare=(402, 4000), extract=(0, 0))
        keys = [k for k, _ in w.find_problems('unhealthy', ['TypeError: boom'], probes)]
        self.assertEqual(keys, ['health', 'logs', 'route-verify', 'header-compare', 'route-extract'])

    def test_error_pattern(self):
        self.assertTrue(w.ERROR_LINE.search('Unhandled rejection'))
        self.assertFalse(w.ERROR_LINE.search('[payment] 0 unresolved payment(s)'))
        self.assertFalse(w.ERROR_LINE.search('errorless terrors'))

    def test_header_bytes_matches_raw_response(self):
        raw = 'HTTP/1.1 402 Payment Required\r\na: 1\r\nbb: 22\r\n\r\n'
        self.assertEqual(w.header_bytes(402, 'Payment Required', [('a', '1'), ('bb', '22')]), len(raw))


class Main(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.state = os.path.join(self.dir.name, 'state.json')
        self.patches = [mock.patch.object(w, 'STATE_PATH', self.state),
                        mock.patch.object(w, 'probe_route', return_value=(402, 3633)),
                        mock.patch.object(w, 'new_error_lines', return_value=[])]
        for p in self.patches:
            p.start()

    def tearDown(self):
        for p in self.patches:
            p.stop()
        self.dir.cleanup()

    def test_alerts_once_then_mutes_then_realerts_after_recovery(self):
        with mock.patch.object(w, 'container_health', return_value='unhealthy'), \
             mock.patch.object(w, 'report') as report:
            w.main(now=1000)
            w.main(now=1300)
            self.assertEqual(report.call_count, 1)
        with mock.patch.object(w, 'container_health', return_value='healthy'), \
             mock.patch.object(w, 'report') as report:
            w.main(now=1600)
            report.assert_not_called()
        with mock.patch.object(w, 'container_health', return_value='unhealthy'), \
             mock.patch.object(w, 'report') as report:
            w.main(now=1900)
            self.assertEqual(report.call_count, 1)

    def test_quiet_when_ok(self):
        with mock.patch.object(w, 'container_health', return_value='healthy'), \
             mock.patch.object(w, 'report') as report:
            w.main(now=1000)
            report.assert_not_called()


if __name__ == '__main__':
    unittest.main()
