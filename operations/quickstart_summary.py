#!/usr/bin/env python3
"""Private, read-only quickstart funnel report with mandatory owner-ledger exclusions."""
import argparse
import json
import pathlib
import subprocess
import sys


def controlled_ids(directory):
    root = pathlib.Path(directory)
    if not root.is_dir() or root.is_symlink():
        raise ValueError('Controlled-payment ledger directory is unavailable')
    ids = set()
    for path in sorted(root.glob('*.json')):
        if path.is_symlink() or not path.is_file() or path.stat().st_size > 65536:
            raise ValueError('Invalid controlled-payment ledger file')
        ledger = json.loads(path.read_text())
        if not isinstance(ledger, dict):
            raise ValueError('Invalid controlled-payment ledger')
        if ledger.get('excludeFromExternalDemand') is not True:
            continue
        values = ledger.get('controlledJobIds')
        if not isinstance(values, list):
            raise ValueError('Missing controlled payment IDs')
        for value in values:
            if (not isinstance(value, str) or not 1 <= len(value) <= 80
                    or any(c not in 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-' for c in value)):
                raise ValueError('Invalid controlled payment ID')
            ids.add(value)
    if len(ids) > 100:
        raise ValueError('Review controlled-payment exclusions: more than 100 IDs')
    return sorted(ids)


def report(container, directory):
    ids = controlled_ids(directory)
    result = subprocess.run(['docker', 'exec', '-e', 'VW_CONTROLLED_JOB_IDS=' + ','.join(ids),
                             container, 'node', 'dist/growth-summary.js', '/data/vw.db'],
                            capture_output=True, text=True, timeout=60, check=True)
    summary = json.loads(result.stdout)
    funnel = summary.get('quickstart')
    if not isinstance(funnel, dict) or funnel.get('available') is not True:
        raise ValueError('Quickstart measurement unavailable; missing data is not zero')
    return {'observedAt': summary['observedAt'], 'quickstart': funnel,
            'exclusions': {'controlledLedgerLoaded': True, 'controlledJobCount': len(ids),
                           'sources': ['monitor', 'test-client'], 'modes': ['test', 'testnet']}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--container', default='viewport-witness')
    parser.add_argument('--controlled-directory', default='/var/lib/viewport-witness-controlled')
    args = parser.parse_args()
    try:
        print(json.dumps(report(args.container, args.controlled_directory), indent=2))
    except (OSError, ValueError, subprocess.SubprocessError):
        print('Quickstart report unavailable: check the local ledger, container and analytics schema. No zero-sales claim was made.', file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
