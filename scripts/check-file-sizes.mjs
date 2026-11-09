// File size guard. Every tracked code file must stay at or under 500 lines.
// Files that were already larger are listed in file-size-ceilings.json at their
// size when the rule started: they may shrink but never grow.
//
//   npm run check:size            check, exit 1 on any problem
//   npm run check:size -- --update  lower ceilings to current sizes (never raises)
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const HARD_LIMIT = 500
export const TARGET = 300
const CODE_FILE = /\.(ts|mts|cts|js|mjs|cjs|py|sh)$/
// Build output and generated evidence are never hand-edited, so they are not size-checked.
const SKIP = [/^dist\//, /^node_modules\//, /^coverage\//, /^samples\//]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ceilingsPath = resolve(root, 'scripts/file-size-ceilings.json')

export function countLines(text) {
  if (text.length === 0) return 0
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
}

export function checkSizes(sizes, ceilings) {
  const problems = []
  const lowered = {}
  for (const [file, lines] of Object.entries(sizes)) {
    const ceiling = ceilings[file]
    if (ceiling === undefined) {
      if (lines > HARD_LIMIT) {
        problems.push(`${file}: ${lines} lines is over the ${HARD_LIMIT}-line limit. Split it into smaller files.`)
      }
    } else if (lines > ceiling) {
      problems.push(`${file}: grew to ${lines} lines, its ceiling is ${ceiling}. Move new code into its own file.`)
    } else if (lines < ceiling) {
      lowered[file] = lines
      problems.push(`${file}: shrank to ${lines} lines, lower its ceiling from ${ceiling} (run npm run check:size -- --update).`)
    }
  }
  for (const file of Object.keys(ceilings)) {
    if (!(file in sizes)) {
      problems.push(`${file}: listed in ceilings but no longer exists. Remove the entry (run npm run check:size -- --update).`)
    }
  }
  return { problems, lowered }
}

export function updatedCeilings(sizes, ceilings) {
  const next = {}
  for (const [file, ceiling] of Object.entries(ceilings)) {
    if (!(file in sizes)) continue
    const lines = Math.min(sizes[file], ceiling)
    if (lines > HARD_LIMIT) next[file] = lines
  }
  return Object.fromEntries(Object.entries(next).sort(([a], [b]) => a.localeCompare(b)))
}

function trackedCodeFiles() {
  const out = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  return out
    .split('\0')
    .filter((file) => file && CODE_FILE.test(file) && !SKIP.some((rule) => rule.test(file)))
    .filter((file) => existsSync(resolve(root, file)))
}

function main() {
  const ceilings = JSON.parse(readFileSync(ceilingsPath, 'utf8')).ceilings
  const sizes = Object.fromEntries(
    trackedCodeFiles().map((file) => [file, countLines(readFileSync(resolve(root, file), 'utf8'))]),
  )

  if (process.argv.includes('--update')) {
    const next = updatedCeilings(sizes, ceilings)
    const doc = JSON.parse(readFileSync(ceilingsPath, 'utf8'))
    doc.ceilings = next
    writeFileSync(ceilingsPath, JSON.stringify(doc, null, 2) + '\n')
    console.info(`Ceilings updated: ${Object.keys(next).length} files above ${HARD_LIMIT} lines.`)
    return
  }

  const { problems } = checkSizes(sizes, ceilings)
  if (problems.length > 0) {
    console.error('File size check failed:')
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.info(
    `File size check passed: ${Object.keys(sizes).length} code files, ` +
      `${Object.keys(ceilings).length} on the ceilings list (target ${TARGET}, limit ${HARD_LIMIT}).`,
  )
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main()
