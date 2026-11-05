import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const SHA = /^[0-9a-f]{40}$/i
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/

export function assertPublishCandidate({ repository, sha, ref, checkoutSha, mainSha, runs }) {
  if (!REPOSITORY.test(repository ?? '')) throw new Error('Invalid repository')
  if (!SHA.test(sha ?? '')) throw new Error('Invalid selected commit SHA')
  if (ref !== 'refs/heads/main') throw new Error('Publish only from main')
  if (checkoutSha !== sha) throw new Error('Checkout does not match selected commit')
  if (mainSha !== sha) throw new Error('main moved after the workflow was dispatched')
  if (!Array.isArray(runs)) throw new Error('Code checks response is missing workflow runs')
  const successful = runs.some((run) =>
    run?.head_sha === sha &&
    run?.head_branch === 'main' &&
    run?.event === 'push' &&
    run?.status === 'completed' &&
    run?.conclusion === 'success',
  )
  if (!successful) throw new Error('No successful push Code checks run for the exact commit')
}

async function getJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'viewport-witness-registry-guard',
    },
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)
  return response.json()
}

async function main() {
  const repository = process.env.GITHUB_REPOSITORY
  const sha = process.env.GITHUB_SHA
  const ref = process.env.GITHUB_REF
  if (!REPOSITORY.test(repository ?? '') || !SHA.test(sha ?? '') || ref !== 'refs/heads/main') {
    throw new Error('Registry publishing requires a selected main commit')
  }

  const checkoutSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // The manifest must still be the one checked into the selected commit.
  execFileSync('git', ['diff', '--quiet', 'HEAD', '--', 'server.json'])

  const api = `https://api.github.com/repos/${repository}`
  const [branch, checks] = await Promise.all([
    getJson(`${api}/branches/main`),
    getJson(
      `${api}/actions/workflows/code-checks.yml/runs?branch=main&event=push&head_sha=${sha}&status=success&per_page=100`,
    ),
  ])
  assertPublishCandidate({
    repository,
    sha,
    ref,
    checkoutSha,
    mainSha: branch?.commit?.sha,
    runs: checks?.workflow_runs,
  })
  console.log(`Registry publication guard passed for ${sha}`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(`Registry publication guard failed: ${error.message}`)
    process.exitCode = 1
  })
}
