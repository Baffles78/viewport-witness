param([Parameter(Mandatory=$true)][string]$NodePath,
      [Parameter(Mandatory=$true)][string]$BridgePath,
      [Parameter(Mandatory=$true)][string]$OptionsBase64)
$ErrorActionPreference = 'Stop'
$ApiId = $null; $ApiSecret = $null; $WalletSecret = $null; $Payer = $null
function Read-Masked([string]$Label) {
    $secure = Read-Host -Prompt $Label -AsSecureString
    if ($null -eq $secure -or $secure.Length -eq 0 -or $secure.Length -gt 8190) {
        if ($null -ne $secure) { $secure.Dispose() }
        throw 'Input cancelled or too long.'
    }
    return $secure
}
function Set-SecretEnvironment($Info, [string]$Key, [Security.SecureString]$Secure) {
    $pointer = [IntPtr]::Zero
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
        $Info.EnvironmentVariables[$Key] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    }
}
function Invoke-Stage([ValidateSet('public','account','execute','resume')][string]$Mode) {
    $info = New-Object System.Diagnostics.ProcessStartInfo
    $info.FileName = $NodePath
    # Only this fixed packaged path and a fixed enum enter Windows argument quoting.
    $info.Arguments = '"' + $BridgePath + '" ' + $Mode
    $info.UseShellExecute = $false; $info.CreateNoWindow = $true
    foreach ($key in @('NODE_OPTIONS','NODE_PATH','NODE_DEBUG','NODE_DEBUG_NATIVE','NODE_TLS_REJECT_UNAUTHORIZED','DEBUG','CDP_API_KEY_ID','CDP_API_KEY_SECRET','CDP_WALLET_SECRET','VW_PAYER_ADDRESS')) { $info.EnvironmentVariables.Remove($key) }
    $info.EnvironmentVariables['VW_SETUP_OPTIONS'] = $OptionsBase64
    if ($Mode -eq 'account' -or $Mode -eq 'execute') {
        Set-SecretEnvironment $info 'CDP_API_KEY_ID' $ApiId
        Set-SecretEnvironment $info 'CDP_API_KEY_SECRET' $ApiSecret
        $info.EnvironmentVariables['VW_PAYER_ADDRESS'] = $Payer
    }
    if ($Mode -eq 'execute') { Set-SecretEnvironment $info 'CDP_WALLET_SECRET' $WalletSecret }
    $child = New-Object System.Diagnostics.Process
    $child.StartInfo = $info
    try { [void]$child.Start(); $child.WaitForExit(); return $child.ExitCode }
    finally {
        foreach ($key in @('CDP_API_KEY_ID','CDP_API_KEY_SECRET','CDP_WALLET_SECRET','VW_PAYER_ADDRESS','VW_SETUP_OPTIONS')) { $info.EnvironmentVariables.Remove($key) }
        $child.Dispose()
    }
}
try {
    if ($BridgePath -ne (Join-Path $PSScriptRoot 'setup-bridge.mjs') -or $BridgePath.Contains('"') -or !(Test-Path -LiteralPath $NodePath -PathType Leaf) -or $OptionsBase64.Length -gt 12000) { throw 'Invalid setup bridge.' }
    $decoded = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($OptionsBase64))
    $parsed = ConvertFrom-Json -InputObject $decoded
    $options = @($parsed | ForEach-Object { [string]$_ })
    if ($options -contains '--resume') { exit (Invoke-Stage 'resume') }
    $result = Invoke-Stage 'public'
    if ($result -ne 0) { exit $result }
    if (($options -contains '--check-account') -or ($options -contains '--execute')) {
        $ApiId = Read-Masked 'CDP API key ID (masked)'
        $ApiSecret = Read-Masked 'CDP API key secret (single-line Ed25519 recommended, masked)'
        $payerIndex = [Array]::IndexOf($options, '--payer')
        if ($payerIndex -ge 0) { $Payer = $options[$payerIndex + 1] } else { $Payer = Read-Host 'Existing public Base payer address' }
        if ($Payer -notmatch '^0x[a-fA-F0-9]{40}$') { throw 'Invalid public payer.' }
        $result = Invoke-Stage 'account'
        if ($result -ne 0) { exit $result }
    }
    if ($options -contains '--execute') {
        $WalletSecret = Read-Masked 'CDP Wallet Secret (masked; explicit execution only)'
        exit (Invoke-Stage 'execute')
    }
    exit 0
} catch { Write-Host 'SETUP_CANCELLED_OR_FAILED: no automatic retry. Preserve any existing checkpoint.'; exit 2 }
finally {
    foreach ($secure in @($ApiId, $ApiSecret, $WalletSecret)) { if ($null -ne $secure) { $secure.Dispose() } }
    $ApiId = $null; $ApiSecret = $null; $WalletSecret = $null; $Payer = $null
}
