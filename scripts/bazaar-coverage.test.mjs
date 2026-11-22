import { test } from 'node:test'
import assert from 'node:assert/strict'
import { discoveryJson, merchantCoverage, validateProducts, PRODUCT_PATHS } from './lib/bazaar-coverage.mjs'
const base = 'https://qa.example.com'
const response = body => new Response(JSON.stringify(body))

test('catalog paginates independently of search rank and rejects lookalike origins', async () => {
  let calls = 0
  const fetchFn = async url => {
    const offset = Number(new URL(url).searchParams.get('offset'))
    calls++
    return offset === 0 ? response({
      resources: [{resource:base+'/v1/checks'},{resource:base+'.evil/v1/verify'}],
      pagination:{offset:0,limit:2,total:3},
    }) : response({resources:[{resource:base+'/v1/verify'}],pagination:{offset:2,limit:2,total:3}})
  }
  const result = await merchantCoverage(base,['0xabc','0xabc'],fetchFn)
  assert.equal(calls,2)
  assert.equal(result.complete,true)
  assert.deepEqual(result.found,['/v1/checks','/v1/verify'])
  assert.deepEqual(result.missing,['/v1/compare','/v1/extract','/v1/security-gate'])
})

test('truncated pagination yields unknown rather than missing products', async () => {
  const result = await merchantCoverage(base,['0xabc'],async()=>response({
    resources:[{resource:base+'/v1/checks'}],pagination:{offset:0,limit:2,total:4},
  }))
  assert.equal(result.complete,false)
  assert.deepEqual(result.missing,[])
  assert.ok(result.unknown.includes('/v1/compare'))
})

test('malformed or unavailable catalogs do not turn into empty catalogs', async () => {
  await assert.rejects(merchantCoverage(base,['0xabc'],async()=>response({resources:[]})),/pagination/)
  await assert.rejects(merchantCoverage(base,['0xabc'],async()=>new Response('',{status:503})),/503/)
  await assert.rejects(merchantCoverage(base,[],async()=>response({})),/addresses/)
  await assert.rejects(discoveryJson('https://example.com',{},async()=>new Response('x'.repeat(2*1024*1024+1))),/2 MiB/)
})

test('official validation is unsigned read-only diagnostics with explicit limits', async () => {
  let count=0
  const results=await validateProducts(base,async(url,options)=>{
    assert.equal(url,'https://api.cdp.coinbase.com/platform/v2/x402/validate')
    assert.equal(options.method,'POST')
    assert.equal(options.redirect,'error')
    assert.ok(!Object.keys(options.headers).some(key=>/payment|authorization/i.test(key)))
    assert.equal(JSON.parse(options.body).method,'POST')
    count++
    return response({valid:true,simulation:{outcome:'accepted'},preflight:[],index:{active:true}})
  })
  assert.equal(count,PRODUCT_PATHS.length)
  assert.ok(results.every(row=>row.valid&&row.accepted&&row.indexActive))
})
