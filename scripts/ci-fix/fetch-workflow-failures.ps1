param(
    [string[]]$WorkflowNames = @('Contract Check', 'Smoke Test E2E'),
    [string]$Branch = '',
    [int]$Limit = 3,
    [string]$OutputDir = 'logs/ci-fix',
    [switch]$UseApiFallback
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Info {
    param([string]$Message)
    Write-Host "[ci-fix:fetch] $Message"
}

function Invoke-GhJson {
    param([string[]]$Arguments)
    $jsonText = & gh @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "gh command failed: gh $($Arguments -join ' ')"
    }
    if ([string]::IsNullOrWhiteSpace($jsonText)) {
        return $null
    }
    return ($jsonText | ConvertFrom-Json)
}

function Classify-Error {
    param([string]$ErrorText)

    if ($ErrorText -match 'Check drift failed|Type check generated client|validate:schema|openapi|remote ref main|fatal: couldn''t find remote ref') {
        return 'deterministic'
    }

    if ($ErrorText -match 'Error while copying content to a stream|smoke script failed after|docker compose startup failed') {
        return 'deterministic'
    }

    if ($ErrorText -match 'npm ci failed after 3 attempts') {
        return 'flaky'
    }

    if ($ErrorText -match 'E503|ETIMEDOUT|ECONNRESET|502|503|504|network|rate limit|timeout|timed out') {
        return 'flaky'
    }

    if ($ErrorText -match 'No space left|runner unavailable|resource temporarily unavailable') {
        return 'infrastructure_noise'
    }

    return 'unknown'
}

function Get-FirstErrorLine {
    param([string[]]$Lines)

    $patterns = @(
        'npm ERR!',
        'fatal:',
        'error',
        'exception',
        'failed',
        'timed out',
        'timeout'
    )

    $lastCandidate = ''
    foreach ($line in $Lines) {
        $candidate = $line.Trim()
        if ([string]::IsNullOrWhiteSpace($candidate)) {
            continue
        }
        foreach ($pattern in $patterns) {
            if ($candidate.ToLowerInvariant().Contains($pattern)) {
                $lastCandidate = $candidate
            }
        }
    }

    if (-not [string]::IsNullOrWhiteSpace($lastCandidate)) {
        return $lastCandidate
    }

    if ($Lines.Count -gt 0) {
        return $Lines[0].Trim()
    }
    return ''
}

function Ensure-Preflight {
    gh --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'gh CLI is not installed or not available in PATH.'
    }

    gh auth status | Out-Null
    if ($LASTEXITCODE -ne 0) {
        if ($env:GITHUB_TOKEN) {
            $tmp = Join-Path $env:TEMP 'gh-token.txt'
            Set-Content -Path $tmp -Value $env:GITHUB_TOKEN -NoNewline
            try {
                Get-Content -Path $tmp | gh auth login --with-token
            }
            finally {
                Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
            }

            gh auth status | Out-Null
            if ($LASTEXITCODE -ne 0) {
                throw 'Unable to authenticate gh with GITHUB_TOKEN.'
            }
        }
        else {
            throw 'gh auth status failed and GITHUB_TOKEN is not set.'
        }
    }

    gh repo view | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to access repository through gh repo view.'
    }
}

if ([string]::IsNullOrWhiteSpace($Branch)) {
    $Branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Branch)) {
        throw 'Unable to determine current branch. Pass -Branch explicitly.'
    }
}

Ensure-Preflight

$resolvedOutputDir = if ([System.IO.Path]::IsPathRooted($OutputDir)) {
    $OutputDir
}
else {
    Join-Path (Get-Location) $OutputDir
}
New-Item -ItemType Directory -Path $resolvedOutputDir -Force | Out-Null

$timestamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$sessionDir = Join-Path $resolvedOutputDir "fetch-$timestamp"
New-Item -ItemType Directory -Path $sessionDir -Force | Out-Null

$summaries = New-Object System.Collections.Generic.List[object]

foreach ($workflowName in $WorkflowNames) {
    Write-Info "Collecting failures for workflow: $workflowName (branch: $Branch)"

    $runs = Invoke-GhJson -Arguments @(
        'run', 'list',
        '--workflow', $workflowName,
        '--branch', $Branch,
        '--status', 'failure',
        '--limit', "$Limit",
        '--json', 'databaseId,workflowName,headSha,status,conclusion,createdAt,updatedAt,url,displayTitle'
    )

    if ($null -eq $runs -or @($runs).Count -eq 0) {
        Write-Info "No failed runs found for workflow: $workflowName"
        continue
    }

    foreach ($run in @($runs)) {
        $runId = "$($run.databaseId)"
        $workflowDirName = ($workflowName -replace '[^A-Za-z0-9_.-]', '_')
        $runDir = Join-Path (Join-Path $sessionDir $workflowDirName) $runId
        New-Item -ItemType Directory -Path $runDir -Force | Out-Null

        $failedLogPath = Join-Path $runDir 'failed.log'
        $jobsJsonPath = Join-Path $runDir 'jobs.json'

        Write-Info "Downloading logs for run $runId"

        $failedLog = & gh run view $runId --log-failed
        if ($LASTEXITCODE -ne 0) {
            $failedLog = & gh run view $runId --log
        }
        Set-Content -Path $failedLogPath -Value $failedLog

        $jobsJson = & gh run view $runId --json jobs,status,conclusion,name
        if ($LASTEXITCODE -eq 0) {
            Set-Content -Path $jobsJsonPath -Value $jobsJson
        }

        $artifactDir = Join-Path $runDir 'artifacts'
        New-Item -ItemType Directory -Path $artifactDir -Force | Out-Null
        & gh run download $runId --dir $artifactDir | Out-Null

        $logLines = @((Get-Content -Path $failedLogPath) | Where-Object { $_ -ne $null })
        $logText = ($logLines -join "`n")
        $firstError = ''
        if ($logText -match 'Error while copying content to a stream\.') {
            $firstError = 'Error while copying content to a stream.'
        }
        if ([string]::IsNullOrWhiteSpace($firstError)) {
            $firstError = Get-FirstErrorLine -Lines $logLines
        }
        $classification = Classify-Error -ErrorText $firstError

        $summaries.Add([pscustomobject]@{
            workflowName = $workflowName
            runId = $runId
            headSha = "$($run.headSha)"
            status = "$($run.status)"
            conclusion = "$($run.conclusion)"
            createdAt = "$($run.createdAt)"
            updatedAt = "$($run.updatedAt)"
            url = "$($run.url)"
            displayTitle = "$($run.displayTitle)"
            firstErrorLine = $firstError
            classification = $classification
            runDir = $runDir
        })
    }
}

$summaryJsonPath = Join-Path $sessionDir 'failures-summary.json'
$summaryMdPath = Join-Path $sessionDir 'failures-summary.md'

$summaryArray = @($summaries.ToArray())
$summaryArray | ConvertTo-Json -Depth 8 | Set-Content -Path $summaryJsonPath

$md = New-Object System.Collections.Generic.List[string]
$md.Add('# CI Failure Summary')
$md.Add('')
$md.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss zzz')")
$md.Add("")
$md.Add('| Workflow | Run ID | Classification | First Error | SHA |')
$md.Add('|---|---|---|---|---|')

if ($summaryArray.Count -gt 0) {
    foreach ($item in $summaryArray) {
        $firstErrorRaw = "$($item.firstErrorLine)"
        $firstErrorEscaped = ($firstErrorRaw -replace '\|', '\\|')
        $md.Add("| $($item.workflowName) | $($item.runId) | $($item.classification) | $firstErrorEscaped | $($item.headSha) |")
    }
}

if ($summaryArray.Count -eq 0) {
    $md.Add('| (none) | - | - | No failed runs found for requested workflows/branch. | - |')
}

Set-Content -Path $summaryMdPath -Value $md

$latestPointerPath = Join-Path $resolvedOutputDir 'latest-fetch-path.txt'
Set-Content -Path $latestPointerPath -Value $sessionDir

Write-Info "Summary JSON: $summaryJsonPath"
Write-Info "Summary MD: $summaryMdPath"
Write-Info "Latest pointer: $latestPointerPath"