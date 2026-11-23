import { test } from 'node:test'
import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'

const powershell = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe')
const engines = process.platform === 'win32' ? [powershell, 'pwsh.exe'] : []
for (const engine of engines) {
  test(`${path.basename(engine)} parses and runs fixed setup with spaces, masked stages, cancellation and safe environments`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vw setup fixture '))
    try {
      const ps = path.join(root, 'windows-setup.ps1'), bridge = path.join(root, 'setup-bridge.mjs')
      await fs.copyFile(new URL('./windows-setup.ps1', import.meta.url), ps)
      await fs.writeFile(bridge, `
import assert from 'node:assert/strict';
import {appendFileSync} from 'node:fs';
const mode=process.argv[2];
for(const key of ['NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE','NODE_TLS_REJECT_UNAUTHORIZED','DEBUG']) assert.equal(process.env[key],undefined);
if(mode==='public'||mode==='resume') for(const key of ['CDP_API_KEY_ID','CDP_API_KEY_SECRET','CDP_WALLET_SECRET','VW_PAYER_ADDRESS']) assert.equal(process.env[key],undefined);
else {
assert.equal(process.env.CDP_API_KEY_ID,'SENTINEL_ID');
assert.equal(process.env.CDP_API_KEY_SECRET,'SENTINEL_API');
assert.equal(process.env.VW_PAYER_ADDRESS,'0x'+'11'.repeat(20));
assert.equal(process.env.CDP_WALLET_SECRET,mode==='execute'?'SENTINEL_WALLET':undefined);
}
appendFileSync(process.env.VW_FIXTURE_LOG,mode+'\\n');
console.log('FIXTURE_STAGE_OK');
`)
      const host = path.join(root, 'host.ps1')
      await fs.writeFile(host, `param([string]$Helper,[string]$Node,[string]$Bridge,[string]$Options,[string]$Answers)
$global:answerQueue = New-Object 'System.Collections.Generic.Queue[string]'
$parsedAnswers = ConvertFrom-Json -InputObject $Answers
foreach ($answer in $parsedAnswers) { $global:answerQueue.Enqueue($answer) }
function global:Read-Host { param([string]$Prompt,[switch]$AsSecureString)
if ($global:answerQueue.Count -eq 0) { throw 'Unexpected credential prompt' }
$value = $global:answerQueue.Dequeue()
if ($AsSecureString) { $secure = New-Object Security.SecureString; foreach ($char in $value.ToCharArray()) { $secure.AppendChar($char) }; $secure.MakeReadOnly(); return $secure }; return $value }
& $Helper -NodePath $Node -BridgePath $Bridge -OptionsBase64 $Options
exit $LASTEXITCODE
`)
      const base = ['--url', 'https://example.com', '--payer', `0x${'11'.repeat(20)}`]
      const cases = [
        { args: base, answers: [], modes: ['public'], code: 0 },
        { args: [...base, '--check-account'], answers: ['SENTINEL_ID', 'SENTINEL_API'], modes: ['public', 'account'], code: 0 },
        { args: [...base, '--execute', '--run-id', 'same-run', '--network', 'base', '--recipient', `0x${'22'.repeat(20)}`, '--budget', '0.08'], answers: ['SENTINEL_ID', 'SENTINEL_API', 'SENTINEL_WALLET'], modes: ['public', 'account', 'execute'], code: 0 },
        { args: [...base, '--check-account'], answers: [], modes: ['public'], code: 2 },
        { args: ['--resume', '--output', root], answers: [], modes: ['resume'], code: 0 },
      ]
      for (const [index, fixture] of cases.entries()) {
        const log = path.join(root, `stages-${index}.txt`)
        const result = spawnSync(engine, ['-NoLogo', '-NoProfile', '-File', host, '-Helper', ps, '-Node', process.execPath, '-Bridge', bridge, '-Options', Buffer.from(JSON.stringify(fixture.args)).toString('base64'), '-Answers', JSON.stringify(fixture.answers)], { encoding: 'utf8', timeout: 15000, windowsHide: true, env: { ...process.env, VW_FIXTURE_LOG: log, CDP_API_KEY_ID: 'INHERITED_SENTINEL', CDP_API_KEY_SECRET: 'INHERITED_SENTINEL', CDP_WALLET_SECRET: 'INHERITED_SENTINEL', NODE_OPTIONS: '--invalid-preload-SENTINEL', NODE_PATH: 'SENTINEL', NODE_DEBUG: '*', NODE_TLS_REJECT_UNAUTHORIZED: '0' } })
        assert.equal(result.status, fixture.code, `${result.stdout}\n${result.stderr}`)
        assert.doesNotMatch(result.stdout + result.stderr, /SENTINEL|Unexpected credential prompt/)
        assert.deepEqual((await fs.readFile(log, 'utf8')).trim().split(/\r?\n/), fixture.modes)
      }
    } finally { await fs.rm(root, { recursive: true, force: true }) }
  })
}
