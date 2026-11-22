#!/usr/bin/env python3
"""Always-on public GitHub thread alerts. No Gmail/X credentials or AI runtime."""
import datetime
import json
import pathlib
import urllib.request

from feedback_notify import atomic_state, telegram_send

STATE = pathlib.Path('/var/lib/viewport-witness-pilot-public/state.json')
EXPIRES = datetime.datetime(2026, 12, 7, 5, tzinfo=datetime.timezone.utc)
API = 'https://api.github.com/repos/daydreamsai/lucid-agents/issues/1738/comments?per_page=100'
THREAD = 'https://github.com/daydreamsai/lucid-agents/issues/1738'
START = '2026-11-22T20:13:18Z'


def read_ids():
    request = urllib.request.Request(API, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'ViewportWitness-pilot-reply-watch'})
    with urllib.request.urlopen(request, timeout=20) as response:
        raw = response.read(1024 * 1024 + 1)
        if len(raw) > 1024 * 1024 or 'rel="next"' in response.headers.get('Link', ''):
            raise ValueError('PUBLIC_THREAD_LIMIT')
    rows = json.loads(raw)
    if not isinstance(rows, list) or len(rows) > 100:
        raise ValueError('INVALID_RESPONSE')
    ids = []
    for row in rows:
        if (not isinstance(row, dict) or not isinstance(row.get('id'), int)
                or not isinstance(row.get('user'), dict) or not isinstance(row.get('created_at'), str)):
            raise ValueError('INVALID_COMMENT')
        if row['user'].get('login') != 'Baffles78' and row['created_at'] >= START:
            ids.append(str(row['id']))
    return ids


def check(state_path=STATE, fetch=read_ids, sender=telegram_send, now=None):
    now = now or datetime.datetime.now(datetime.timezone.utc)
    if now >= EXPIRES:
        return {'expired': True}
    state = json.loads(state_path.read_text()) if state_path.exists() else {'seen': [], 'pending': [], 'health': None}
    if not isinstance(state.get('seen'), list) or not isinstance(state.get('pending'), list):
        raise ValueError('INVALID_STATE')

    def flush():
        while state['pending']:
            event = state['pending'][0]
            sender(event['text'])
            state['seen'] = sorted(set(state['seen']) | set(event.get('ids', [])))
            state['pending'].pop(0)
            atomic_state(state_path, state)

    flush()
    try:
        ids = fetch()
        unseen = sorted(set(ids) - set(state['seen']))
        if state.get('health') == 'failed':
            state['pending'].append({'text': 'ViewportWitness: always-on Daydreams GitHub reply checks recovered. Gmail and X remain dependent on their separate connections.'})
        if unseen:
            state['pending'].append({'ids': unseen, 'text': f'ViewportWitness pilot: {len(unseen)} new public comment(s) in the Daydreams conversation. Author identity and interest are unverified.\n{THREAD}\nReview before deciding enrollment. No automatic reply or enrollment was made.'})
        state['health'] = 'ok'
        state['last_checked_at'] = now.isoformat()
    except Exception:
        if state.get('health') != 'failed':
            state['pending'].append({'text': 'ViewportWitness: always-on Daydreams GitHub reply check failed. This is not confirmation of no replies. It will retry hourly; Gmail and X coverage are separate.'})
        state['health'] = 'failed'
        state['last_attempt_at'] = now.isoformat()
    atomic_state(state_path, state)
    flush()
    if state['health'] != 'ok':
        raise RuntimeError('PUBLIC_REPLY_CHECK_FAILED')
    return {'health': 'ok', 'new_comments': len(unseen), 'checked_at': state['last_checked_at']}


if __name__ == '__main__':
    try:
        print(json.dumps(check()))
    except Exception:
        # Never propagate HTTP exception URLs (the shared sender uses a secret URL).
        raise SystemExit('PUBLIC_REPLY_CHECK_OR_ALERT_UNCONFIRMED') from None
