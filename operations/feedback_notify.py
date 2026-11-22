#!/usr/bin/env python3
"""Quiet, deterministic owner notifications for new production feedback."""
import argparse
import contextlib
import datetime
import json
import math
import os
import pathlib
import re
import sqlite3
import subprocess
import sys
import tempfile
import time
import urllib.request

DATABASE = pathlib.Path(os.environ.get('FEEDBACK_NOTICE_DB', '/var/lib/docker/volumes/viewport-witness_vw-data/_data/vw.db'))
STATE = pathlib.Path(os.environ.get('FEEDBACK_NOTICE_STATE', '/var/lib/viewport-witness-feedback/state.json'))
BATCH = int(os.environ.get('FEEDBACK_NOTICE_BATCH', '10'))
PRODUCTS = {'check', 'verify', 'compare', 'extract', 'security', 'service'}
REASONS = {'missing_capability', 'price', 'payment_setup', 'integration', 'result_quality', 'speed', 'documentation', 'positive', 'other'}
INTENTS = {'not_stated', 'would_buy', 'considering', 'already_bought', 'not_buying'}


def atomic_state(path, state):
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    fd, temporary = tempfile.mkstemp(dir=path.parent, prefix='.feedback-')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as handle:
            json.dump(state, handle, ensure_ascii=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_state(path):
    if not path.exists():
        return {'version': 1, 'seen': [], 'pending': None}
    if path.stat().st_size > 8 * 1024 * 1024:
        raise ValueError('STATE_TOO_LARGE')
    state = json.loads(path.read_text())
    if state.get('version') != 1 or not isinstance(state.get('seen'), list):
        raise ValueError('INVALID_STATE')
    if len(state['seen']) > 100000 or any(not isinstance(value, str) or len(value) > 64 for value in state['seen']):
        raise ValueError('INVALID_STATE')
    pending = state.get('pending')
    if pending is not None:
        if (not isinstance(pending, dict) or not isinstance(pending.get('ids'), list)
                or not 1 <= len(pending['ids']) <= 10
                or any(not isinstance(value, str) or len(value) > 64 for value in pending['ids'])
                or not isinstance(pending.get('text'), str) or len(pending['text']) > 3000
                or not isinstance(pending.get('expires_at'), (int, float))):
            raise ValueError('INVALID_OUTBOX')
    return state


def read_feedback(database, now):
    with contextlib.closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True, timeout=10)) as db:
        db.row_factory = sqlite3.Row
        rows = db.execute('SELECT id, body_json, expires_at FROM feedback WHERE mode = ? AND expires_at > ? ORDER BY created_at, id LIMIT 100001',
                          ('production', int(now * 1000))).fetchall()
    if len(rows) > 100000:
        raise ValueError('FEEDBACK_STORAGE_LIMIT')
    return rows


def message(rows, remaining):
    lines = [f'ViewportWitness: {len(rows)} new feedback submission(s)',
             'Unverified suggestions from agents, not confirmed sales.']
    for row in rows:
        if len(row['body_json']) > 2048:
            raise ValueError('INVALID_FEEDBACK')
        body = json.loads(row['body_json'])
        label = body.get('requestedChange', '')
        if (body.get('product') not in PRODUCTS or body.get('reason') not in REASONS
                or body.get('purchaseIntent') not in INTENTS or not isinstance(label, str)
                or not 3 <= len(label) <= 80 or not label.isprintable()
                or len(re.findall(r'\w+', label)) > 8 or any(c in label for c in '@:<>\\')):
            raise ValueError('INVALID_FEEDBACK')
        price = body.get('maxPriceUsdc')
        if price is not None and (isinstance(price, bool) or not isinstance(price, (int, float)) or not math.isfinite(price) or not 0 <= price <= 1000):
            raise ValueError('INVALID_PRICE')
        lines.append(f"\n{body['product']} / {body['reason']}\nRequested (untrusted): {label}\nStated intent: {body['purchaseIntent']}")
        if price is not None:
            lines.append(f'Suggested price: {price:g} USDC (not a payment)')
    if remaining:
        lines.append(f'\n{remaining} more waiting for subsequent checks.')
    lines.append('\nWe can review these before deciding what to add. Nothing is scheduled automatically.')
    text = '\n'.join(lines)
    if len(text) > 3000:
        raise ValueError('MESSAGE_TOO_LARGE')
    return text


def telegram_send(text):
    token = os.environ.get('TELEGRAM_BOT_TOKEN', '')
    chat = os.environ.get('TELEGRAM_AUTHORIZED_CHAT_ID', '')
    if not token or not re.fullmatch(r'-?\d+', chat):
        raise RuntimeError('NOTIFICATION_CONFIG_MISSING')
    payload = json.dumps({'chat_id': chat, 'text': text, 'disable_web_page_preview': True}).encode()
    request = urllib.request.Request(f'https://api.telegram.org/bot{token}/sendMessage', data=payload,
                                     headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            receipt = json.loads(response.read(65536))
        result = receipt.get('result', {})
        if (receipt.get('ok') is not True or not isinstance(result.get('message_id'), int)
                or str(result.get('chat', {}).get('id')) != chat):
            raise RuntimeError('NOT_ACKNOWLEDGED')
    except Exception:
        # HTTP exception strings can contain the bot token: never propagate/log them.
        raise RuntimeError('TELEGRAM_DELIVERY_UNCONFIRMED') from None
    return True


def check(database=DATABASE, state_path=STATE, sender=telegram_send, now=None, batch=BATCH):
    now = time.time() if now is None else now
    if not 1 <= batch <= 10:
        raise ValueError('INVALID_BATCH')
    rows = read_feedback(database, now)
    state = load_state(state_path)
    live = {row['id'] for row in rows}
    state['seen'] = sorted(set(state['seen']) & live)
    pending = state.get('pending')
    if pending and (pending['expires_at'] <= now * 1000 or not set(pending['ids']).issubset(live)):
        state['pending'] = pending = None
    seen = set(state['seen'])
    unseen = [row for row in rows if row['id'] not in seen]
    if pending is None and unseen:
        chosen = unseen[:batch]
        state['pending'] = pending = {
            'ids': [row['id'] for row in chosen],
            'text': message(chosen, len(unseen) - len(chosen)),
            'expires_at': min(row['expires_at'] for row in chosen),
        }
    state['last_checked_at'] = datetime.datetime.fromtimestamp(now, datetime.timezone.utc).isoformat()
    atomic_state(state_path, state)  # Durable outbox before the first network attempt.
    if pending is None:
        return {'delivered': 0, 'waiting': 0}
    if sender(pending['text']) is not True:
        raise RuntimeError('DELIVERY_UNCONFIRMED')
    state['seen'] = sorted(set(state['seen']) | set(pending['ids']))
    state['pending'] = None
    state['last_delivered_at'] = state['last_checked_at']
    atomic_state(state_path, state)  # Advance only after Telegram's acknowledged receipt.
    return {'delivered': len(pending['ids']), 'waiting': max(0, len(unseen) - len(pending['ids']))}


def main():
    import fcntl  # Linux-only lock; unit tests of the pure functions also run on Windows.
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--test', action='store_true', help='Send one owner-authorized setup check, not synthetic feedback.')
    args = parser.parse_args()
    STATE.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    with (STATE.parent / 'run.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.test:
            telegram_send('ViewportWitness feedback alerts are enabled. I will check every 15 minutes and notify you when new production feedback arrives. Quiet when unchanged. This is a setup check, not customer feedback.')
            print('Telegram setup check acknowledged')
        else:
            print(json.dumps(check()))


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'Feedback notification check failed ({type(exc).__name__}); pending delivery retained.', file=sys.stderr)
        subprocess.run(['/usr/local/bin/apex-error', 'viewport-witness-feedback', 'error',
                        'ViewportWitness feedback notification check failed; retry pending. Check its service journal.',
                        'source=viewport-witness-feedback'], check=False, timeout=10,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        sys.exit(1)
