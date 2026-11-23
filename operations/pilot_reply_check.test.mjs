import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport, notices, desktopPending, main, EXPIRES, PRIVATE, ROOT} from './pilot_reply_check.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';

const contacts = Array.from({length: 5}, (_, i) => ({code: `B0${i+1}`, recipient: `builder${i+1}`, channel: 'test', thread_url: 'https://example.com'}));
const report = () => ({builders: contacts.map(c => ({code: c.code, status: 'ok', incoming_ids: []}))});
const state = () => ({seen: [], health: {}, pending: []});
test('quiet unchanged checks and reply deduplication', () => {
  const r = report(), s = state();
  assert.deepEqual(notices(validateReport(r, contacts), s, contacts), []);
  r.builders[0].incoming_ids = ['id123', 'id123'];
  assert.equal(notices(r, s, contacts).length, 1);
  assert.match(notices(r, s, contacts)[0].text, /verify the author/);
  s.seen.push('B01:id123');
  assert.equal(notices(r, s, contacts).length, 0);
});
test('access failure and recovery alerts occur only on transitions', () => {
  const r = report(), s = state();
  r.builders[1].status = 'unavailable';
  assert.equal(notices(r, s, contacts).length, 1);
  s.health.B02 = 'unavailable';
  assert.equal(notices(r, s, contacts).length, 0);
  r.builders[1].status = 'ok';
  assert.equal(notices(r, s, contacts).length, 1);
});
test('server-owned public channel cannot generate duplicate desktop alerts', () => {
  const r = report();
  r.builders[2].incoming_ids = ['new-comment'];
  const configured = contacts.map(c => c.code === 'B03' ? {...c, notification_owner: 'vps-public'} : c);
  assert.deepEqual(notices(r, state(), configured), []);
});
test('rejects incomplete, duplicate, invalid-id and ambiguous results', () => {
  for (const mutate of [r => r.builders.pop(), r => r.builders[1].code = 'B01', r => r.builders[0].incoming_ids = ['<script>'], r => {r.builders[0].status = 'unavailable'; r.builders[0].incoming_ids = ['id'];}]) {
    const r = report(); mutate(r);
    assert.throws(() => validateReport(r, contacts), /INVALID_REPORT/);
  }
});

test('B03 remains VPS-owned even if a contact marker is missing; queued alerts are suppressed', () => {
  const r = report();
  r.builders[2].incoming_ids = ['new-comment'];
  assert.deepEqual(notices(r, state(), contacts), []);
  assert.deepEqual(desktopPending([
    {key: 'B03:old'}, {key: 'health:B03:unavailable'}, {key: 'B01:keep'},
  ]), [{key: 'B01:keep'}]);
});

test('expiry precedes state, resolver and notifier access', () => {
  main({now: () => EXPIRES, resolveCodexExecutable: () => {throw Error('MODEL_CALLED');},
    send: () => {throw Error('NOTIFIER_CALLED');}});
  assert.equal(new Date(EXPIRES).toISOString(), '2026-12-07T05:00:00.000Z');
});

test('actual dry-run entry works outside checkout, without state access or subprocesses', () => {
  const entry = new URL('./pilot_reply_check.mjs', import.meta.url);
  const code = `import fs from 'node:fs'; import cp from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    for (const name of ['openSync','writeFileSync','renameSync','unlinkSync','existsSync','realpathSync'])
      fs[name] = () => {throw Error('STATE_ACCESS');};
    cp.spawnSync = () => {throw Error('SUBPROCESS_CALLED');}; syncBuiltinESMExports();
    process.argv = [process.execPath, ${JSON.stringify(fileURLToPath(entry))}, '--dry-run'];
    await import(${JSON.stringify(entry.href)});`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], {
    cwd: os.tmpdir(), encoding: 'utf8', timeout: 10000,
  });
  assert.equal(child.status, 0, child.stderr);
  const output = JSON.parse(child.stdout);
  assert.equal(output.codeRoot, ROOT);
  assert.equal(output.privateRoot, PRIVATE);
  assert.equal(PRIVATE, 'C:/projects/viewport-witness/artifacts/five-builder-pilot');
  assert.equal(output.modelInvoked, false);
  assert.equal(output.notifierInvoked, false);
  assert.equal(output.stateAccessed, false);
  assert.equal(output.fixtureEvents, 0);
});
