import json
import pathlib
import tempfile
import unittest
from unittest.mock import patch
import quickstart_summary as qs


class QuickstartSummaryTests(unittest.TestCase):
    def test_ledger_exclusions_are_automatic_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as root:
            for name in ['a', 'b']:
                pathlib.Path(root, name + '.json').write_text(json.dumps({
                    'excludeFromExternalDemand': True, 'controlledJobIds': ['known-test']}))
            with patch('quickstart_summary.subprocess.run') as run:
                run.return_value.stdout = json.dumps({'observedAt': 'now', 'quickstart': {'available': True, 'startedRuns': 0}})
                result = qs.report('viewport-witness', root)
                self.assertIn('VW_CONTROLLED_JOB_IDS=known-test', run.call_args.args[0])
                self.assertEqual(result['exclusions']['controlledJobCount'], 1)

    def test_bad_or_missing_ledger_stops_instead_of_including_test_payments(self):
        with tempfile.TemporaryDirectory() as root:
            path = pathlib.Path(root, 'a.json')
            path.write_text('{broken')
            with self.assertRaises(ValueError):
                qs.controlled_ids(root)
            path.write_text(json.dumps({'excludeFromExternalDemand': True, 'controlledJobIds': ['wallet:private']}))
            with self.assertRaises(ValueError):
                qs.controlled_ids(root)
        with self.assertRaises(ValueError):
            qs.controlled_ids(root)

    def test_missing_analytics_is_unavailable_instead_of_zero(self):
        with tempfile.TemporaryDirectory() as root, patch('quickstart_summary.subprocess.run') as run:
            run.return_value.stdout = json.dumps({'quickstart': {'available': False}})
            with self.assertRaises(ValueError):
                qs.report('viewport-witness', root)


if __name__ == '__main__':
    unittest.main()
