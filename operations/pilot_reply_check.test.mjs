import test from 'node:test';
import assert from 'node:assert/strict';
import {validateReport, notices} from './pilot_reply_check.mjs';

const contacts = Array.from({length: 5}, (_, i) => ({code: `B0${i+1}`, recipient: `builder${i+1}`, channel: 'test', thread_url: 'https://example.com'}));
const report = () => ({builders: contacts.map(c => ({code: c.code, status: 'ok', incoming_ids: []}))});
const state = () => ({seen: [], health: {}, pending: []});
test('quiet unchanged checks and reply deduplication', () => {
  const r = report(), s = state();
  assert.deepEqual(notices(validateReport(r, contacts), s, contacts), []);
  r.builders[0].incoming_ids = ['id123', 'id123'];
  assert.equal(notices(r, s, contacts).length, 1);
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
test('rejects incomplete, duplicate, invalid-id and ambiguous results', () => {
  for (const mutate of [r => r.builders.pop(), r => r.builders[1].code = 'B01', r => r.builders[0].incoming_ids = ['<script>'], r => {r.builders[0].status = 'unavailable'; r.builders[0].incoming_ids = ['id'];}]) {
    const r = report(); mutate(r);
    assert.throws(() => validateReport(r, contacts), /INVALID_REPORT/);
  }
});
