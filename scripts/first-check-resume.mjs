import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadBoundedJson } from './lib/bounded-json.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const referenceSchema = 'viewport-witness-first-check/v1'
const manifestName = /^manifest-[a-f0-9]{24}\.json$/

export async function saveFirstCheckReference(output, manifestPath) {
  const reference = { schema: referenceSchema, manifest: path.basename(manifestPath) }
  if (!manifestName.test(reference.manifest))
    throw new Error('Expected a generated recovery manifest basename')
  const file = path.join(output, 'first-check.json')
  try {
    await fs.writeFile(file, JSON.stringify(reference, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error.code !== 'EEXIST') throw error
    const old = await loadBoundedJson(file)
    if (!old || old.schema !== reference.schema || old.manifest !== reference.manifest)
      throw new Error(
        'Existing recovery reference belongs to different arguments; preserve this run and reconcile',
      )
  }
}

export async function prepareFirstCheckResume(args) {
  if (
    !args['--output'] ||
    Object.keys(args).some((key) => !['resume', '--output', '--manifest'].includes(key))
  )
    throw new Error(
      'Resume requires --output and accepts only optional --manifest for a legacy run; no wallet, URL, budget or execution options',
    )
  const output = path.resolve(args['--output'])
  const folder = await fs.lstat(output)
  if (!folder.isDirectory() || folder.isSymbolicLink())
    throw new Error('Resume output must be an existing regular directory')
  let manifest = args['--manifest']
  if (!manifest) {
    let reference
    try {
      reference = await loadBoundedJson(path.join(output, 'first-check.json'))
    } catch (error) {
      if (error.code === 'ENOENT')
        throw new Error(
          'Legacy run: supply its original --manifest basename; preserve the checkpoint',
        )
      throw error
    }
    if (!reference || reference.schema !== referenceSchema)
      throw new Error('Invalid recovery reference')
    manifest = reference.manifest
  }
  if (typeof manifest !== 'string' || !manifestName.test(manifest))
    throw new Error('Recovery manifest must be a generated basename in the same output directory')
  const manifestPath = path.join(output, manifest)
  await loadBoundedJson(manifestPath)
  const statePath = path.join(output, 'checkpoint.json')
  let checkpoint
  try {
    checkpoint = await loadBoundedJson(statePath)
  } catch (error) {
    if (error.code === 'ENOENT')
      throw new Error(
        'No saved checkpoint exists. An unpaid preview does not create a report; obtain approval before purchasing',
      )
    throw error
  }
  if (
    !checkpoint ||
    checkpoint.schema !== 'viewport-witness-release/v1' ||
    !Array.isArray(checkpoint.pages) ||
    checkpoint.pages.length !== 1 ||
    checkpoint.pages.some(
      (page) =>
        !page ||
        page.state !== 'accepted' ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(page.jobId ?? ''),
    )
  )
    throw new Error(
      'Only an accepted job can be resumed without paying. Preserve and reconcile uncertain payments; do not start a replacement run',
    )
  return {
    manifestPath,
    output,
    execute: false,
    resume: true,
    clientArgs: [
      path.join(root, 'scripts/release-check.mjs'),
      '--manifest',
      manifestPath,
      '--state',
      statePath,
      '--output',
      path.join(output, 'resumed'),
      '--resume-only',
    ],
  }
}
