param(
    [string]$Branch = '',
    [int]$MaxIterations = 3,
    [int]$PollSeconds = 30,
    [int]$WorkflowTimeoutMinutes = 15,
    [int]$FlakyReruns = 2,
    [string[]]$TargetWorkflows = @('Contract Check', 'Smoke Test E2E'),
    [switch]$DryRun,
    [string]$LogDir = 'logs/ci-fix'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Loop {
    param([string]$Message)
    Write-Host "[ci-fix:iteration] $Message"
}

function Ensure-Preflight {
    gh --version | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'gh CLI not available'
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
            throw 'gh auth missing and GITHUB_TOKEN not set.'
        }
    }

    gh repo view | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'No access to repository (gh repo view failed).'
    }
}

function Get-CurrentHeadSha {
    $sha = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) {
        throw 'Unable to determine HEAD SHA.'
    }
    return $sha
}

function Wait-WorkflowResult {
    param(
        [string]$WorkflowName,
        [string]$CommitSha,
        [int]$PollInterval,
        [int]$TimeoutMinutesValue
    )

    $deadline = (Get-Date).AddMinutes($TimeoutMinutesValue)

    while ((Get-Date) -lt $deadline) {
        $runList = & gh run list --workflow $WorkflowName --commit $CommitSha --limit 1 --json databaseId,status,conclusion,workflowName,url
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to list runs for workflow '$WorkflowName' and commit '$CommitSha'."
        }

        $runs = @($runList | ConvertFrom-Json)
        if ($runs.Count -eq 0) {
            Write-Loop "No run found yet for '$WorkflowName' on commit '$CommitSha'. Waiting..."
            Start-Sleep -Seconds $PollInterval
            continue
        }

        $runId = "$($runs[0].databaseId)"
        $runStateRaw = & gh run view $runId --json status,conclusion,url
        if ($LASTEXITCODE -ne 0) {
            throw "Unable to inspect run '$runId'."
        }

        $runState = $runStateRaw | ConvertFrom-Json
        Write-Loop "Workflow '$WorkflowName' run=$runId status=$($runState.status) conclusion=$($runState.conclusion)"

        if ($runState.status -eq 'completed') {
            return [pscustomobject]@{
                workflow = $WorkflowName
                runId = $runId
                status = "$($runState.status)"
                conclusion = "$($runState.conclusion)"
                url = "$($runState.url)"
            }
        }

        Start-Sleep -Seconds $PollInterval
    }

    return [pscustomobject]@{
        workflow = $WorkflowName
        runId = ''
        status = 'completed'
        conclusion = 'timed_out'
        url = ''
    }
}

if ([string]::IsNullOrWhiteSpace($Branch)) {
    $Branch = (& git branch --show-current).Trim()
    if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($Branch)) {
        throw 'Unable to detect current branch. Pass -Branch explicitly.'
    }
}

$resolvedLogDir = Join-Path (Get-Location) $LogDir
New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
$iterationReportPath = Join-Path $resolvedLogDir ("iteration-report-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.json')

Ensure-Preflight

$report = [System.Collections.ArrayList]::new()
$flakyRerunCounter = @{}

for ($iteration = 1; $iteration -le $MaxIterations; $iteration++) {
    Write-Loop "Iteration $iteration/$MaxIterations"

    $headSha = Get-CurrentHeadSha
    $iterationDir = Join-Path $resolvedLogDir ("iteration-$iteration-$headSha")
    New-Item -ItemType Directory -Path $iterationDir -Force | Out-Null

    ./scripts/ci-fix/fetch-workflow-failures.ps1 -WorkflowNames $TargetWorkflows -Branch $Branch -Limit 1 -OutputDir $iterationDir

    $latestPathFile = Join-Path $iterationDir 'latest-fetch-path.txt'
    if (-not (Test-Path -LiteralPath $latestPathFile)) {
        throw "Missing latest-fetch-path.txt at $latestPathFile"
    }

    $fetchPath = (Get-Content -Path $latestPathFile -Raw).Trim()
    $summaryPath = Join-Path $fetchPath 'failures-summary.json'

    if (-not (Test-Path -LiteralPath $summaryPath)) {
        throw "Missing failures summary at $summaryPath"
    }

    $summary = @((Get-Content -Path $summaryPath -Raw | ConvertFrom-Json))

    $deterministic = @($summary | Where-Object { $_.classification -eq 'deterministic' })
    $flaky = @($summary | Where-Object { $_.classification -eq 'flaky' -or $_.classification -eq 'infrastructure_noise' })

    if ($deterministic.Count -gt 0) {
        Write-Loop "Deterministic failures detected ($($deterministic.Count)). Must fix deterministic errors before flaky reruns."

        $report.Add([pscustomobject]@{
            iteration = $iteration
            headSha = $headSha
            action = 'deterministic_block'
            count = $deterministic.Count
            details = $deterministic
        })

        if ($DryRun) {
            Write-Loop 'DryRun enabled: skipping stop on deterministic failures.'
        }
        else {
            break
        }
    }

    if ($flaky.Count -gt 0) {
        Write-Loop "Flaky/infrastructure failures detected ($($flaky.Count))."

        foreach ($item in $flaky) {
            $key = "$($item.workflowName)"
            if (-not $flakyRerunCounter.ContainsKey($key)) {
                $flakyRerunCounter[$key] = 0
            }

            if ($flakyRerunCounter[$key] -lt $FlakyReruns) {
                $flakyRerunCounter[$key] = [int]$flakyRerunCounter[$key] + 1
                $attempt = $flakyRerunCounter[$key]

                Write-Loop "Flaky rerun $attempt/$FlakyReruns for workflow '$key'"
                if (-not $DryRun) {
                    gh workflow run $key --ref $Branch | Out-Null
                    if ($LASTEXITCODE -ne 0) {
                        throw "Failed to dispatch workflow '$key'"
                    }
                }

                $report.Add([pscustomobject]@{
                    iteration = $iteration
                    headSha = $headSha
                    action = 'flaky_rerun'
                    workflow = $key
                    attempt = $attempt
                })
            }
            else {
                $report.Add([pscustomobject]@{
                    iteration = $iteration
                    headSha = $headSha
                    action = 'flaky_rerun_exhausted'
                    workflow = $key
                    attempt = $flakyRerunCounter[$key]
                })
            }
        }
    }

    $allWorkflowStates = [System.Collections.ArrayList]::new()
    foreach ($workflowName in $TargetWorkflows) {
        $state = Wait-WorkflowResult -WorkflowName $workflowName -CommitSha $headSha -PollInterval $PollSeconds -TimeoutMinutesValue $WorkflowTimeoutMinutes
        $allWorkflowStates.Add($state)
    }

    $nonSuccess = @($allWorkflowStates | Where-Object { $_.conclusion -ne 'success' })
    $report.Add([pscustomobject]@{
        iteration = $iteration
        headSha = $headSha
        action = 'workflow_status'
        states = @($allWorkflowStates)
    })

    if ($nonSuccess.Count -eq 0) {
        Write-Loop 'All target workflows are green on current HEAD SHA.'
        break
    }

    Write-Loop "Some workflows still non-success ($($nonSuccess.Count)). Next iteration will continue if budget remains."
}

@($report) | ConvertTo-Json -Depth 12 | Set-Content -Path $iterationReportPath
Write-Loop "Iteration report: $iterationReportPath"