import { afterEach, describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import type { JobStore } from '../src/db.js'
import type { WorkerRunner } from '../src/worker/runner.js'
import { servers, makeConfig, makeMockStore, startMcpServer, callToolsList } from './helpers/mcp-server.js'

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (s) =>
        new Promise<void>((resolve) => {
          s.close(() => resolve())
        }),
    ),
  )
})

describe('MCP get_report same-job reconciliation', () => {
  const id = '11111111-1111-4111-8111-111111111111'

  async function poll(status: string | null, reportPath: string | null = null) {
    const store = {
      ...makeMockStore(),
      getJob: () => status ? { id, status, reportPath } : null,
    } as unknown as JobStore
    const { port } = await startMcpServer(makeConfig(), store)
    const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'get_report', arguments: { jobId: id } },
      }),
    })
    const payload = await response.json() as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean }
    }
    return {
      isError: payload.result?.isError,
      body: JSON.parse(payload.result?.content?.[0]?.text ?? '{}') as Record<string, unknown>,
    }
  }

  for (const status of ['queued', 'running', 'retryable']) {
    it(`${status} keeps polling the same ID`, async () => {
      const result = await poll(status)
      expect(result.body).toMatchObject({
        id,
        status,
        jobStatus: status,
        nextAction: 'poll_same_job',
        retryAfterSeconds: 5,
      })
    })
  }

  it('permanent failure stops', async () => {
    expect((await poll('failed')).body).toMatchObject({
      id, status: 'failed', jobStatus: 'failed', nextAction: 'stop',
    })
  })

  it('missing or expired ID stops', async () => {
    const result = await poll(null)
    expect(result.isError).toBe(true)
    expect(result.body).toMatchObject({ error: 'not_found', nextAction: 'stop' })
  })

  it('completed job without a report stops', async () => {
    const result = await poll('complete')
    expect(result.isError).toBe(true)
    expect(result.body).toMatchObject({ error: 'report_unavailable', nextAction: 'stop' })
  })

  it('completed report asks for inspection', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vw-mcp-reconcile-'))
    try {
      const reportPath = path.join(dir, 'report.json')
      await fs.writeFile(reportPath, JSON.stringify({ id, kind: 'extract', status: 'PASS' }))
      expect((await poll('complete', reportPath)).body).toMatchObject({
        id, status: 'PASS', jobStatus: 'complete', nextAction: 'inspect_report',
      })
    } finally {
      await fs.rm(dir, { recursive: true, force: true })
    }
  })
})

describe('MCP tools/list — tool annotations', () => {
  it('check_page marks its on-chain payment as destructive', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'check_page')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.annotations?.destructiveHint).toBe(true)
    expect(tool?.annotations?.openWorldHint).toBe(true)
  })

  it('verify_page marks its on-chain payment as destructive', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.annotations?.destructiveHint).toBe(true)
    expect(tool?.annotations?.openWorldHint).toBe(true)
  })

  it('compare_page marks its on-chain payment as destructive', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'compare_page')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(false)
    expect(tool?.annotations?.destructiveHint).toBe(true)
    expect(tool?.annotations?.openWorldHint).toBe(true)
  })

  it('get_report has readOnlyHint=true, destructiveHint=false, openWorldHint=false', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'get_report')
    expect(tool).toBeDefined()
    expect(tool?.annotations?.readOnlyHint).toBe(true)
    expect(tool?.annotations?.destructiveHint).toBe(false)
    expect(tool?.annotations?.openWorldHint).toBe(false)
  })
})

describe('MCP tools/list — tool descriptions', () => {
  it('check_page description mentions $0.08 USDC and x402', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'check_page')
    expect(tool?.description).toContain('0.08')
    expect(tool?.description?.toLowerCase()).toContain('x402')
  })

  it('check_page description states x402-aware client is required', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'check_page')
    expect(tool?.description?.toLowerCase()).toContain('x402-aware')
  })

  it('get_report description mentions free and read-only', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'get_report')
    expect(tool?.description?.toLowerCase()).toContain('free')
    expect(tool?.description?.toLowerCase()).toContain('read-only')
  })

  it('verify_page description lists assertion types', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    expect(tool?.description).toContain('noHorizontalOverflow')
    expect(tool?.description).toContain('noConsoleErrors')
  })

  it('disambiguates broad QA from assertion-based verification', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const check = response.result?.tools?.find((t) => t.name === 'check_page')
    const verify = response.result?.tools?.find((t) => t.name === 'verify_page')
    expect(check?.description).toContain('For explicit pass/fail assertions use verify_page')
    expect(verify?.description).toContain('For broad exploratory browser QA use check_page')
  })

  it('provides descriptions for every top-level input parameter', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    for (const tool of response.result?.tools ?? []) {
      const properties = (tool.inputSchema?.properties ?? {}) as Record<
        string,
        Record<string, unknown>
      >
      for (const schema of Object.values(properties)) {
        expect(typeof schema.description).toBe('string')
        expect((schema.description as string).length).toBeGreaterThan(0)
      }
    }
  })
})

describe('MCP tools/list — verify_page assertions schema', () => {
  it('verify_page has assertions in inputSchema', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    const assertions = tool?.inputSchema?.properties?.['assertions'] as
      Record<string, unknown> | undefined
    expect(assertions).toBeDefined()
  })

  it('verify_page assertions schema is a discriminated union (not generic object)', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    const assertions = tool?.inputSchema?.properties?.['assertions'] as
      Record<string, unknown> | undefined
    // The array items should have anyOf or oneOf — not just { type: 'object' }
    const items = assertions?.['items'] as Record<string, unknown> | undefined
    expect(items).toBeDefined()
    const hasDiscrimination = 'anyOf' in (items ?? {}) || 'oneOf' in (items ?? {})
    expect(hasDiscrimination).toBe(true)
  })

  it('verify_page assertions schema covers all six assertion types', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const tool = response.result?.tools?.find((t) => t.name === 'verify_page')
    const assertions = tool?.inputSchema?.properties?.['assertions'] as
      Record<string, unknown> | undefined
    const items = assertions?.['items'] as Record<string, unknown> | undefined
    const variants = ((items?.['anyOf'] ?? items?.['oneOf']) as unknown[]) ?? []
    expect(variants.length).toBe(6)
  })
})

describe('MCP tools/list — all six tools present', () => {
  it('returns exactly six tools', async () => {
    const { port } = await startMcpServer(makeConfig())
    const response = await callToolsList(port)
    const names = response.result?.tools?.map((t) => t.name) ?? []
    expect(names).toContain('check_page')
    expect(names).toContain('verify_page')
    expect(names).toContain('compare_page')
    expect(names).toContain('extract_page')
    expect(names).toContain('web_release_gate')
    expect(names).toContain('get_report')
    expect(names.length).toBe(6)
  })
})

describe('MCP worker admission', () => {
  it('rejects a new tool job when quarantined while free retrieval remains available', async () => {
    const store = makeMockStore()
    const runner = { isHealthy: () => false, enqueue: async () => {
      throw new Error('should not enqueue')
    } } as unknown as WorkerRunner
    const { port } = await startMcpServer(makeConfig(), store, runner)
    const call = async (name: string, args: Record<string, string>) => {
      const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 5, method: 'tools/call',
          params: { name, arguments: args } }),
      })
      return response.json() as Promise<{ result?: { content?: Array<{ text?: string }>; isError?: boolean } }>
    }
    const blocked = await call('check_page', { url: 'https://example.com' })
    expect(blocked.result?.isError).toBe(true)
    expect(JSON.parse(blocked.result?.content?.[0]?.text ?? '{}')).toMatchObject({
      error: 'worker_unavailable',
    })
    const retrieval = await call('get_report', { jobId: '11111111-1111-4111-8111-111111111111' })
    expect(JSON.parse(retrieval.result?.content?.[0]?.text ?? '{}')).toMatchObject({
      error: 'not_found',
    })
  })
})
