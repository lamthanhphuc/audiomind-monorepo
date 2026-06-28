# Port of log-safety-scan.sh for Windows (Gate-A log-safety gate).
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Set-Location $repoRoot

$allowlistPath = Join-Path $repoRoot 'scripts\ci\log-safety-allowlist.txt'
$base = if ($env:LOG_SAFETY_BASE) { $env:LOG_SAFETY_BASE } else { 'origin/main' }

$forbidden = @(
    'first16hex'
    'base64'
    'byte dump'
    'Authorization'
    'Bearer '
    'DEEPGRAM_API_KEY'
    'GEMINI_API_KEY'
    'raw transcript'
    'raw audio'
    'deviceId'
    'prompt text'
    'Gemini raw response'
    'groupedActionPlan'
    'grouped_action_plan'
)

function Test-IsAllowlisted {
    param([string]$File, [string]$Line)
    if (-not (Test-Path $allowlistPath)) { return $false }
    foreach ($rule in Get-Content $allowlistPath) {
        if ([string]::IsNullOrWhiteSpace($rule) -or $rule.StartsWith('#')) { continue }
        if ($rule -notmatch ':') {
            if ($File -like "$rule*") { return $true }
            continue
        }
        $prefix, $needle = $rule -split ':', 2
        if ($File -eq $prefix -and $Line -like "*$needle*") { return $true }
    }
    return $false
}

function Test-IsLoggerLine {
    param([string]$Line)
    return ($Line -match 'log\.(info|warn|error|debug)\(') -or
        ($Line -match 'logger\.(info|warning|error|debug|bind)\(') -or
        ($Line -match 'console\.(log|warn|error)\(')
}

function Get-ScanFiles {
    $files = @()
    $gitBaseOk = $false
    try {
        git rev-parse --verify $base 2>$null | Out-Null
        if ($LASTEXITCODE -eq 0) { $gitBaseOk = $true }
    } catch { $gitBaseOk = $false }

    if ($gitBaseOk) {
        $files = @(git diff --name-only "${base}...HEAD" 2>$null)
    }
    if (-not $files -or $files.Count -eq 0) {
        $files = @(git ls-files `
            'demoRecordAUDIOMID/**/*.java' `
            'demoRecordAUDIOMID/**/*.py' `
            'FE-Audiomind/src/**/*.ts' `
            'FE-Audiomind/src/**/*.tsx')
    }

    foreach ($file in $files) {
        if ([string]::IsNullOrWhiteSpace($file)) { continue }
        if ($file -notmatch '\.(java|py|ts|tsx)$') { continue }
        if ($file -match 'test|Test|\.md$') { continue }
        if (Test-Path $file) { $file }
    }
}

$violations = 0
foreach ($file in Get-ScanFiles) {
    $lineNo = 0
    foreach ($line in Get-Content $file) {
        $lineNo++
        if (-not (Test-IsLoggerLine $line)) { continue }
        if (Test-IsAllowlisted $file $line) { continue }
        foreach ($token in $forbidden) {
            if ($line -like "*$token*") {
                Write-Host "LOG_SAFETY_VIOLATION ${file}:${lineNo} contains forbidden $token"
                $violations++
            }
        }
    }
}

if ($violations -gt 0) {
    Write-Error "log-safety-scan failed with $violations violation(s)"
    exit 1
}

Write-Host 'log-safety-scan passed'
