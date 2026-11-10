#!/usr/bin/env python3
"""Every few minutes: look for app errors that /health cannot see, and report them.

Checks the container health, new error lines in its logs, and that every paid route
still answers 402 with headers small enough for nginx. Problems are appended through
/usr/local/bin/apex-error, which the existing VPS alerter sends to Telegram. Never
restarts anything. Repeats of the same problem are muted for ALERT_REPEAT_SECONDS.
"""
import json, os, re, subprocess, time, urllib.error, urllib.request

CONTAINER = os.environ.get('WATCH_CONTAINER', 'viewport-witness')
BASE_URL = os.environ.get('WATCH_BASE_URL', 'http://127.0.0.1:3402')
STATE_PATH = os.environ.get('WATCH_STATE', '/var/lib/viewport-witness-watch/state.json')
HEADER_LIMIT = int(os.environ.get('WATCH_HEADER_LIMIT', '3900'))
REPEAT_SECONDS = int(os.environ.get('ALERT_REPEAT_SECONDS', '3600'))
PAID_ROUTES = ('checks', 'verify', 'compare', 'extract', 'security-gate')
ERROR_LINE = re.compile(r'\b(error|exception|unhandled|fatal)\b', re.IGNORECASE)
SOURCE = 'viewport-witness-watch'


def run(cmd):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(cmd, 124, '', 'docker command timed out')


def container_health():
    out = run(['docker', 'inspect', '--format', '{{.State.Health.Status}}', CONTAINER])
    if out.returncode == 124:
        return 'unknown (docker timed out)'
    return out.stdout.strip() if out.returncode == 0 else 'missing'


def new_error_lines(since):
    out = run(['docker', 'logs', '--since', since, CONTAINER])
    if out.returncode == 124:
        return ['error: docker logs timed out']
    lines = (out.stdout + out.stderr).splitlines()
    return [line for line in lines if ERROR_LINE.search(line)]


def header_bytes(status, reason, headers):
    size = len(f'HTTP/1.1 {status} {reason}\r\n'.encode())
    for name, value in headers:
        size += len(f'{name}: {value}\r\n'.encode())
    return size + 2


def probe_route(route):
    req = urllib.request.Request(f'{BASE_URL}/v1/{route}', method='POST',
                                 data=b'{"url":"https://example.com"}',
                                 headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            return resp.status, header_bytes(resp.status, resp.reason, resp.getheaders())
    except urllib.error.HTTPError as err:
        return err.code, header_bytes(err.code, err.reason, err.headers.items())
    except (urllib.error.URLError, OSError):
        return 0, 0


def find_problems(health, error_lines, probes):
    problems = []
    if health != 'healthy':
        problems.append(('health', f'Container health is {health}.'))
    if error_lines:
        problems.append(('logs', f'{len(error_lines)} new error line(s) in container logs; '
                                 'run docker logs --since 10m viewport-witness.'))
    for route, (status, size) in probes.items():
        if status != 402:
            problems.append((f'route-{route}', f'POST /v1/{route} returned {status or "no answer"}, expected 402.'))
        elif size >= HEADER_LIMIT:
            problems.append((f'header-{route}', f'POST /v1/{route} 402 headers are {size} bytes '
                                                f'(limit {HEADER_LIMIT}; nginx fails at 4096).'))
    return problems


def load_state():
    try:
        with open(STATE_PATH) as fh:
            return json.load(fh)
    except (OSError, ValueError):
        return {}


def save_state(state):
    os.makedirs(os.path.dirname(STATE_PATH), exist_ok=True)
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w') as fh:
        json.dump(state, fh)
    os.replace(tmp, STATE_PATH)


def report(message):
    subprocess.run(['/usr/local/bin/apex-error', SOURCE, 'error', message, f'source={SOURCE}'],
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10, check=True)


def main(now=None):
    now = now or time.time()
    state = load_state()
    since = str(int(state.get('last_run', now - 600)))
    problems = find_problems(container_health(), new_error_lines(since),
                             {route: probe_route(route) for route in PAID_ROUTES})
    muted = state.get('alerted', {})
    for key, message in problems:
        if key not in muted or now - muted[key] >= REPEAT_SECONDS:
            report(message)
            muted[key] = now
    active = {key for key, _ in problems}
    state = {'last_run': now, 'alerted': {k: v for k, v in muted.items() if k in active}}
    save_state(state)
    print(f'{len(problems)} problem(s)' if problems else 'ok')


if __name__ == '__main__':
    try:
        main()
    except Exception as exc:  # report a broken watch instead of failing silently
        report(f'Error watch itself failed ({type(exc).__name__}); check journalctl -u viewport-witness-watch.')
        raise
