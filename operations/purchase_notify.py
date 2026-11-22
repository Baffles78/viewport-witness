#!/usr/bin/env python3
"""Notify the owner of new first-observed production payers; never sign or retry payments."""
import argparse
import contextlib
import datetime
import hashlib
import json
import math
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import time
from feedback_notify import atomic_state, load_state, telegram_send
from quickstart_summary import controlled_ids

DATABASE = pathlib.Path(os.environ.get('PURCHASE_NOTICE_DB', '/var/lib/docker/volumes/viewport-witness_vw-data/_data/vw.db'))
STATE = pathlib.Path(os.environ.get('PURCHASE_NOTICE_STATE', '/var/lib/viewport-witness-purchases/state.json'))
CONTROLLED = pathlib.Path(os.environ.get('PURCHASE_CONTROLLED_DIRECTORY', '/var/lib/viewport-witness-controlled'))
DAY_MS = 86400000


def read_candidates(database, directory, now):
    excluded = set(controlled_ids(directory))  # Missing/broken exclusion evidence fails closed.
    with contextlib.closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        db.execute('BEGIN')
        metadata = dict(db.execute('SELECT key,value FROM quickstart_meta').fetchall())
        if (not metadata.get('started_at') or metadata.get('write_failures', 0)
                or metadata.get('capacity_drops', 0)):
            raise ValueError('INCOMPLETE_PURCHASE_HISTORY')
        rows = db.execute('SELECT job_id,customer_id,source,created_at,paid_at FROM quickstart_jobs '
                          'WHERE created_at>=? AND created_at<=? ORDER BY paid_at,job_id LIMIT 50001',
                          (int(now * 1000) - 90 * DAY_MS, int(now * 1000))).fetchall()
    if len(rows) >= 50000:
        raise ValueError('PURCHASE_HISTORY_CAPACITY')
    first = {}
    for row in rows:
        if (row['job_id'] in excluded or row['source'] in {'monitor', 'test-client'}
                or row['paid_at'] is None or row['paid_at'] > now * 1000):
            continue
        customer = row['customer_id']
        if not isinstance(customer, str) or not re.fullmatch(r'cust_[a-f0-9]{64}', customer):
            continue  # Missing identity cannot establish a first purchase.
        identity = hashlib.sha256(('purchase-alert/v1:' + customer).encode()).hexdigest()
        if identity not in first:
            first[identity] = {'id': identity, 'expires_at': row['created_at'] + 90 * DAY_MS}
    return list(first.values())


def message(count):
    return (f'ViewportWitness: {count} first-observed real purchase(s)\n'
            'Production USDC payment accepted from a newly observed payer. '
            'Report processing is tracked separately.\n'
            'Monitors, test clients and known controlled payments are excluded.\n'
            'First observed within retained history; this is not verified agent or lifetime customer identity.')


def check(database=DATABASE, state_path=STATE, directory=CONTROLLED, sender=telegram_send, now=None):
    now = time.time() if now is None else now
    if not math.isfinite(now) or now <= 0:
        raise ValueError('INVALID_TIME')
    candidates = read_candidates(database, directory, now)
    state = load_state(state_path)
    stamp = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
    if 'activated_at' not in state:
        if state_path.exists():
            raise ValueError('INVALID_PURCHASE_STATE')
        state.update(activated_at=stamp, seen=[row['id'] for row in candidates], last_checked_at=stamp)
        atomic_state(state_path, state)  # Establish baseline without announcing historical sales.
        return {'delivered': 0, 'waiting': 0, 'baseline': True}
    if len(state['seen']) >= 99990:
        raise ValueError('NOTIFICATION_STATE_CAPACITY')
    # Rebuild the outbox from current eligible history on every retry. Newly excluded tests
    # must never be delivered from stale pending text. Retain seen payer hashes across expiry.
    seen = set(state['seen'])
    unseen = [row for row in candidates if row['id'] not in seen]
    chosen = unseen[:10]
    state['pending'] = pending = ({'ids': [row['id'] for row in chosen],
                                 'text': message(len(chosen)),
                                 'expires_at': min(row['expires_at'] for row in chosen)} if chosen else None)
    state['last_checked_at'] = stamp
    atomic_state(state_path, state)
    if pending is None:
        return {'delivered': 0, 'waiting': 0}
    if sender(pending['text']) is not True:
        raise RuntimeError('DELIVERY_UNCONFIRMED')
    state['seen'] = sorted(seen | set(pending['ids']))
    state['pending'] = None
    state['last_delivered_at'] = stamp
    atomic_state(state_path, state)
    return {'delivered': len(chosen), 'waiting': len(unseen) - len(chosen)}


def main():
    import fcntl
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test', action='store_true', help='Send a setup check, never a synthetic sale.')
    args = parser.parse_args()
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE.parent / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.test:
            telegram_send('ViewportWitness first-purchase alerts are enabled. I will check every five minutes for a first-observed real production purchase, excluding monitors and known tests. Quiet when unchanged. This is a setup check, not a sale.')
            print('Telegram purchase-alert setup check acknowledged')
        else:
            print(json.dumps(check()))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Purchase notification check failed ({type(exc).__name__}); delivery state retained.', file=sys.stderr)
        subprocess.run(['/usr/local/bin/apex-error', 'viewport-witness-purchases', 'error',
                        'ViewportWitness first-purchase alert check failed; inspect its service journal.',
                        'source=viewport-witness-purchases'], check=False, timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.exit(1)
