import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { pathToFileURL, fileURLToPath } from 'node:url'

test('actual doctor entry returns static unsafe-input codes in JSON and human output before network access', () => {
  const entry = pathToFileURL(fileURLToPath(new URL('./doctor.mjs', import.meta.url))).href
  for (const [url, code] of [
    ['https://user:SENTINEL_SECRET@example.com/', 'TARGET_CREDENTIALS_FORBIDDEN'],
    ['https://127.0.0.1/SENTINEL', 'TARGET_NOT_PUBLIC'],
    ['http://example.com/SENTINEL', 'TARGET_HTTPS_REQUIRED'],
  ]) {
    for (const json of [false, true]) {
      const args = ['--url', url, ...(json ? ['--json'] : [])]
      const fixture = `let calls=0;globalThis.fetch=async()=>{calls++;throw Error('NETWORK_NOT_ALLOWED')};const {main}=await import(${JSON.stringify(entry)});const result=await main(${JSON.stringify(args)});process.exitCode=calls?99:result;`
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', fixture], {
        encoding: 'utf8',
        timeout: 10000,
      })
      assert.equal(result.status, 2)
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /SENTINEL|user:|127\.0\.0\.1|NETWORK_NOT_ALLOWED/,
      )
      if (json) assert.equal(JSON.parse(result.stdout).stages[0].code, code)
      else assert.match(result.stderr, new RegExp(code))
    }
  }
})
