import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport, validateCollection, notices, desktopPending, main, EXPIRES, PRIVATE, ROOT} from './pilot_reply_check.mjs';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';

const contacts = Array.from({length: 5}, (_, i) => ({code: `B0${i+1}`, recipient: `builder${i+1}`, channel: 'test', thread_url: 'https://example.com'}));
const report = () => ({builders: contacts.map(c => ({code: c.code, status: 'ok', incoming_ids: []}))});
const state = () => ({seen: [], health: {}, pending: []});

test('desktop collection requires fresh evidence and rejects replay before committing', () => {
  const now = Date.parse('2026-11-26T12:00:00Z');
  const bundle = {collected_at: new Date(now - 1000).toISOString(), ...report()};
  assert.equal(validateCollection(bundle, contacts, null, now), bundle);
  for (const time of [now + 1, now - 600001, NaN]) {
    assert.throws(() => validateCollection({...bundle, collected_at: String(time)}, contacts, null, now));
  }
  assert.throws(() => validateCollection(bundle, contacts, bundle.collected_at, now), /STALE_COLLECTION/);
  assert.throws(() => validateCollection({...bundle, builders: []}, contacts, null, now), /INVALID_REPORT/);
});

test('app collection commits with shared deduplication, acknowledged outbox and lock', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vw-app-replies-'));
  const now = Date.parse('2026-11-26T12:00:00Z');
  const write = (file, data) => fs.writeFileSync(path.join(root, file), JSON.stringify(data));
  const read = file => JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
  const initial = state(); initial.health.B02 = 'unavailable';
  const bundle = {...report(), collected_at: new Date(now - 1000).toISOString()};
  bundle.builders[1].incoming_ids = ['incoming-id'];
  write('OUTREACH-STATE.json', {contacts}); write('REPLY-WATCH-STATE.json', initial);
  write('reply-app-result.json', bundle);
  const sent = [];
  const options = {stateRoot: root, applyCollection: true, now: () => now,
    resolveCodexExecutable: () => {throw Error('MODEL_CALLED');}};
  try {
    assert.throws(() => main({...options, send: () => {throw Error('NO_ACK');}}), /NO_ACK/);
    assert.equal(read('REPLY-WATCH-STATE.json').seen.length, 0);
    assert.equal(read('REPLY-WATCH-STATE.json').pending.length, 2);
    bundle.collected_at = new Date(now).toISOString(); write('reply-app-result.json', bundle);
    main({...options, send: text => sent.push(text)});
    assert.equal(sent.length, 2);
    assert.deepEqual(read('REPLY-WATCH-STATE.json').seen, ['B02:incoming-id']);
    assert.equal(read('REPLY-WATCH-STATE.json').pending.length, 0);
    assert.equal(read('REPLY-WATCH-STATE.json').health.B02, 'ok');
    assert.throws(() => main({...options, send: () => {throw Error('SHOULD_NOT_SEND');}}), /STALE_COLLECTION/);
    assert.equal(fs.existsSync(path.join(root, 'reply-check.lock')), false);
  } finally { fs.rmSync(root, {recursive: true}); }
});
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
    import {syncBuiltinESMExports} from 'node:module'; import {fileURLToPath} from 'node:url';
    for (const name of ['writeFileSync','renameSync','unlinkSync','existsSync'])
      fs[name] = () => {throw Error('STATE_ACCESS');};
    const open = fs.openSync;
    const codePath = ${JSON.stringify(fileURLToPath(entry))};
    fs.openSync = (file, flags, ...rest) => {
      if ((file instanceof URL ? fileURLToPath(file) : String(file)) !== codePath || flags !== 'r') throw Error('STATE_ACCESS');
      return open(file, flags, ...rest);
    };
    // Linux's ESM loader resolves the code file through public realpathSync.
    // Allow loading code, while rejecting any read/resolve of canonical private state.
    const privateRoot = ${JSON.stringify(PRIVATE.toLowerCase())};
    for (const name of ['realpathSync', 'readFileSync']) {
      const original = fs[name];
      fs[name] = (...args) => {
        const target = String(args[0]).replaceAll('\\\\', '/').toLowerCase();
        if (target.includes(privateRoot)) throw Error('STATE_ACCESS');
        return original(...args);
      };
    }
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
