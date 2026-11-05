import assert from 'node:assert/strict'
import test from 'node:test'
import { assertPublishCandidate } from './registry-publish-guard.mjs'

const sha = 'a'.repeat(40)
const valid = () => ({
  repository: 'Baffles78/viewport-witness',
  sha,
  ref: 'refs/heads/main',
  checkoutSha: sha,
  mainSha: sha,
  runs: [{
    head_sha: sha,
    head_branch: 'main',
    event: 'push',
    status: 'completed',
    conclusion: 'success',
  }],
})

test('accepts a successful push Code checks run for the exact current main commit', () => {
  assert.doesNotThrow(() => assertPublishCandidate(valid()))
})

for (const [name, change] of Object.entries({
  'selected branch': { ref: 'refs/heads/feature' },
  'changed checkout': { checkoutSha: 'b'.repeat(40) },
  'advanced main': { mainSha: 'b'.repeat(40) },
  'other commit success': { runs: [{ ...valid().runs[0], head_sha: 'b'.repeat(40) }] },
  'PR-only success': { runs: [{ ...valid().runs[0], event: 'pull_request' }] },
  'failed checks': { runs: [{ ...valid().runs[0], conclusion: 'failure' }] },
  'running checks': { runs: [{ ...valid().runs[0], status: 'in_progress' }] },
  'missing evidence': { runs: [] },
  'malformed evidence': { runs: undefined },
})) {
  test(`rejects ${name}`, () => {
    assert.throws(() => assertPublishCandidate({ ...valid(), ...change }))
  })
}
