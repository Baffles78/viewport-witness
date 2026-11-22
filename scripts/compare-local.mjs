// Offline PNG comparison. Never fetches pages, loads wallets, or purchases reports.
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { compareWithExclusions } from '../dist/worker/visual-exclusions.js'
import { VIEWPORTS } from '../dist/types.js'

try {
  const args = {}
  for (let i = 2; i < process.argv.length; i += 2) {
    const key = process.argv[i]
    const value = process.argv[i + 1]
    if (!['--baseline', '--current', '--regions', '--viewport', '--output'].includes(key) ||
        Object.hasOwn(args, key) || !value || value.startsWith('--')) {
      throw new Error('Use --baseline PNG --current PNG --viewport NAME --regions JSON --output NEW_DIRECTORY.')
    }
    args[key] = value
  }
  const dimensions = VIEWPORTS[args['--viewport']]
  if (!Object.hasOwn(VIEWPORTS, args['--viewport']) || !dimensions ||
      !args['--baseline'] || !args['--current'] || !args['--regions'] || !args['--output']) {
    throw new Error('Baseline, current, regions, output and a supported viewport are required.')
  }
  async function readBounded(file, maxBytes) {
    const handle = await fs.open(file, 'r')
    try {
      const buffer = Buffer.alloc(maxBytes + 1)
      let read = 0
      while (read < buffer.length) {
        const result = await handle.read(buffer, read, buffer.length - read, null)
        if (!result.bytesRead) break
        read += result.bytesRead
      }
      if (read > maxBytes) throw new Error('Input file exceeds its size limit.')
      return buffer.subarray(0, read)
    } finally { await handle.close() }
  }
  const baseline = await readBounded(args['--baseline'], 8 * 1024 * 1024)
  const current = await readBounded(args['--current'], 8 * 1024 * 1024)
  const regions = JSON.parse((await readBounded(args['--regions'], 16 * 1024)).toString('utf8'))
  const result = compareWithExclusions(baseline, current, regions)
  if (result.summary.dimensions.width !== dimensions.width ||
      result.summary.dimensions.height !== dimensions.height) {
    throw new Error('Screenshot dimensions do not match the selected viewport.')
  }
  // A new directory prevents accidental overwrites of original evidence.
  const output = path.resolve(args['--output'])
  await fs.mkdir(output)
  await fs.writeFile(path.join(output, 'diff.png'), result.diff, { flag: 'wx' })
  await fs.writeFile(path.join(output, 'comparison.json'), JSON.stringify({
    ...result.summary, viewport: args['--viewport'],
  }, null, 2) + '\n', { flag: 'wx' })
  console.log(`Saved local visual evidence to ${output}`)
} catch (error) {
  console.error(`Local comparison unavailable: ${error.message}`)
  process.exitCode = 1
}
