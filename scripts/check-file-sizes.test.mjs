import test from 'node:test'
import assert from 'node:assert/strict'
import { checkSizes, countLines, updatedCeilings } from './check-file-sizes.mjs'

test('counts lines with and without a trailing newline', () => {
  assert.equal(countLines(''), 0)
  assert.equal(countLines('a\nb\n'), 2)
  assert.equal(countLines('a\nb'), 2)
})

test('passes small files and files exactly at their ceiling', () => {
  const { problems } = checkSizes({ 'src/a.ts': 120, 'src/big.ts': 900 }, { 'src/big.ts': 900 })
  assert.deepEqual(problems, [])
})

test('fails a new file over the hard limit', () => {
  const { problems } = checkSizes({ 'src/new.ts': 501 }, {})
  assert.equal(problems.length, 1)
  assert.match(problems[0], /over the 500-line limit/)
})

test('fails a listed file that grows past its ceiling', () => {
  const { problems } = checkSizes({ 'src/big.ts': 901 }, { 'src/big.ts': 900 })
  assert.match(problems[0], /grew to 901/)
})

test('asks for the ceiling to be lowered when a file shrinks', () => {
  const { problems } = checkSizes({ 'src/big.ts': 850 }, { 'src/big.ts': 900 })
  assert.match(problems[0], /lower its ceiling/)
})

test('flags ceilings for files that no longer exist', () => {
  const { problems } = checkSizes({}, { 'src/gone.ts': 900 })
  assert.match(problems[0], /no longer exists/)
})

test('update only lowers ceilings and drops files back under the limit', () => {
  const next = updatedCeilings(
    { 'src/a.ts': 850, 'src/b.ts': 950, 'src/c.ts': 400 },
    { 'src/a.ts': 900, 'src/b.ts': 900, 'src/c.ts': 600, 'src/gone.ts': 700 },
  )
  assert.deepEqual(next, { 'src/a.ts': 850, 'src/b.ts': 900 })
})
