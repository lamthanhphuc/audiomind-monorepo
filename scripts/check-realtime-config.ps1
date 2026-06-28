#Requires -Version 5.1
<#
.SYNOPSIS
  Validates realtime smoke-prep environment without printing secret values.
#>
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-RepoRoot {
    param([string]$StartPath = $PSScriptRoot)

    $current = [System.IO.Path]::GetFullPath($StartPath)
    while ($current) {
        $envCandidate = Join-Path $current 'infra\.env'
        if (Test-Path -LiteralPath $envCandidate) {
            return $current
        }
        $parent = Split-Path -Parent $current
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $current) {
            break
        }
        $current = $parent
    }

    return [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
}

$RootDir = Resolve-RepoRoot
$EnvFile = Join-Path $RootDir 'infra\.env'
$EnvFileFound = Test-Path -LiteralPath $EnvFile

$SensitiveKeys = @(
    'DEEPGRAM_API_KEY',
    'GEMINI_API_KEY',
    'JWT_SECRET',
    'POSTGRES_PASSWORD'
)

$MisnamedFinalDrainKeys = @(
    'STT_FINAL_DRAIN_TIMEOUT_SECONDS',
    'STT_FINAL_RECV_TIMEOUT_SECONDS',
    'STT_FINAL_DRAIN_SECONDS'
)

$ForcedWebmParamKeys = @(
    'DEEPGRAM_SAMPLE_RATE',
    'DEEPGRAM_ENCODING',
    'STT_SAMPLE_RATE',
    'STT_ENCODING',
    'DEEPGRAM_STREAM_SAMPLE_RATE',
    'DEEPGRAM_STREAM_ENCODING'
)

function Get-EnvMap {
    param([string]$Path)

    $map = @{}
    if (-not (Test-Path -LiteralPath $Path)) {
        return $map
    }

    Get-Content -LiteralPath $Path | ForEach-Object {
        $line = $_.Trim()
        if (-not $line -or $line.StartsWith('#')) {
            return
        }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) {
            return
        }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.StartsWith('"') -and $value.EndsWith('"')) {
            $value = $value.Substring(1, $value.Length - 2)
        }
        $map[$key] = $value
    }
    return $map
}

function Test-Truthy {
    param([string]$Value)
    switch ($Value.Trim().ToLowerInvariant()) {
        { $_ -in @('1', 'true', 'yes', 'on') } { return $true }
        default { return $false }
    }
}

function Add-Finding {
    param(
        [System.Collections.Generic.List[object]]$Findings,
        [string]$Check,
        [string]$Severity,
        [string]$Message
    )
    $Findings.Add([pscustomobject]@{
            check    = $Check
            severity = $Severity
            message  = $Message
        })
}

$envMap = Get-EnvMap -Path $EnvFile
$findings = [System.Collections.Generic.List[object]]::new()

function Get-Setting {
    param(
        [string]$Key,
        [string]$Default
    )
    if ($envMap.ContainsKey($Key) -and $envMap[$Key]) {
        return $envMap[$Key]
    }
    return $Default
}

$recvDrain = [double](Get-Setting 'STT_RECV_DRAIN_TIMEOUT_SECONDS' '0.1')
if ($recvDrain -ge 1.0) {
    Add-Finding $findings 'stt_recv_drain_timeout_seconds' 'error' 'value must be < 1.0 (expected <= 0.2, default 0.1)'
}
elseif ($recvDrain -gt 0.2) {
    Add-Finding $findings 'stt_recv_drain_timeout_seconds' 'warn' 'value > 0.2 may delay non-final transcript delivery'
}

$finalDrain = [double](Get-Setting 'STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS' '2.0')
if ($finalDrain -lt 1.0) {
    Add-Finding $findings 'stt_final_recv_drain_timeout_seconds' 'error' 'value must be >= 1.0 (default 2.0)'
}

if (-not $envMap.ContainsKey('STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS')) {
    $misnamed = $false
    foreach ($key in $MisnamedFinalDrainKeys) {
        if ($envMap.ContainsKey($key) -and $envMap[$key]) {
            Add-Finding $findings 'stt_final_recv_drain_timeout_seconds' 'warn' "misnamed env $key detected; use STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS"
            $misnamed = $true
            break
        }
    }
    if (-not $misnamed) {
        Add-Finding $findings 'stt_final_recv_drain_timeout_seconds' 'warn' 'STT_FINAL_RECV_DRAIN_TIMEOUT_SECONDS not set; using service default'
    }
}

if (Test-Truthy (Get-Setting 'DEEPGRAM_DEBUG_RAW_MESSAGES' 'false')) {
    Add-Finding $findings 'deepgram_debug_raw_messages' 'error' 'must be false for realtime smoke prep'
}

$provider = (Get-Setting 'STT_PROVIDER' 'deepgram').ToLowerInvariant()
if ($provider -ne 'deepgram') {
    Add-Finding $findings 'stt_provider' 'error' "expected deepgram for realtime smoke, got $provider"
}

if (-not (Test-Truthy (Get-Setting 'REALTIME_ASYNC_AUDIO_QUEUE_ENABLED' 'true'))) {
    Add-Finding $findings 'realtime_async_audio_queue_enabled' 'warn' 'REALTIME_ASYNC_AUDIO_QUEUE_ENABLED is false; final G1 smoke expects true'
}

foreach ($key in $ForcedWebmParamKeys) {
    if ($envMap.ContainsKey($key) -and $envMap[$key]) {
        Add-Finding $findings 'deepgram_forced_webm_params' 'warn' "$key is set; WebM realtime should omit forced sample_rate/encoding"
    }
}

if ($findings.Count -eq 0) {
    Add-Finding $findings 'realtime_config' 'ok' 'all realtime smoke checks passed'
}

$hasError = $false
$hasWarn = $false
foreach ($finding in $findings) {
    if ($finding.severity -eq 'error') { $hasError = $true }
    if ($finding.severity -eq 'warn') { $hasWarn = $true }
}

$status = if ($hasError) { 'error' } elseif ($hasWarn) { 'warn' } else { 'ok' }
Write-Output "REALTIME_CONFIG_GUARD status=$status source=check-realtime-config.ps1 repoRoot=$RootDir"

foreach ($finding in $findings) {
    Write-Output ("REALTIME_CONFIG_GUARD check={0} severity={1} detail={2}" -f $finding.check, $finding.severity, $finding.message)
}

if ($EnvFileFound) {
    Write-Output "REALTIME_CONFIG_GUARD check=infra_env severity=ok detail=infra/.env found"
} else {
    Write-Output "REALTIME_CONFIG_GUARD check=infra_env severity=warn detail=infra/.env not found at $EnvFile"
}

foreach ($key in $SensitiveKeys) {
    if ($envMap.ContainsKey($key) -and $envMap[$key]) {
        Write-Output "REALTIME_CONFIG_GUARD check=$key severity=info detail=present (value redacted)"
    }
}

if ($hasError) {
    exit 1
}
exit 0
