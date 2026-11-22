import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PNG } from 'pngjs'

const script = fileURLToPath(new URL('./compare-local.mjs', import.meta.url))
test('offline CLI saves disclosed exclusions and never overwrites evidence', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-compare-cli-'))
  try {
    const image = new PNG({ width: 375, height: 812 })
    image.data.fill(255)
    const baseline = PNG.sync.write(image)
    image.data.set([0, 0, 0, 255], 0)
    const current = PNG.sync.write(image)
    const before = path.join(dir, 'before.png'), after = path.join(dir, 'after.png')
    const regions = path.join(dir, 'regions.json'), output = path.join(dir, 'output')
    await fs.writeFile(before, baseline)
    await fs.writeFile(after, current)
    await fs.writeFile(regions, JSON.stringify([{ x: 0, y: 0, width: 1, height: 1 }]))
    const args = [script, '--baseline', before, '--current', after,
      '--viewport', 'phonePortrait', '--regions', regions, '--output', output]
    const run = () => spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 10000, windowsHide: true })
    const first = run()
    assert.equal(first.status, 0, first.stderr)
    const summaryPath = path.join(output, 'comparison.json')
    const summaryBytes = await fs.readFile(summaryPath)
    const summary = JSON.parse(summaryBytes)
    assert.equal(summary.rawChangedPixels, 1)
    assert.equal(summary.changedPixels, 0)
    assert.equal(summary.excludedPixels, 1)
    assert.equal(summary.viewport, 'phonePortrait')
    assert.equal(run().status, 1)
    assert.deepEqual(await fs.readFile(summaryPath), summaryBytes)
    assert.deepEqual(await fs.readFile(before), baseline)
    assert.deepEqual(await fs.readFile(after), current)
    const wrongViewport = args.map((arg) => arg === 'phonePortrait' ? 'desktop' : arg)
    wrongViewport[wrongViewport.length - 1] = path.join(dir, 'wrong-output')
    assert.equal(spawnSync(process.execPath, wrongViewport, { encoding: 'utf8', windowsHide: true }).status, 1)
    await assert.rejects(fs.stat(path.join(dir, 'wrong-output')))
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
})
