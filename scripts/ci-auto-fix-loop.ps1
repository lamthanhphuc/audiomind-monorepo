param(
    [string]$Branch = 'production-ready',
    [int]$PollSeconds = 30,
    [int]$InProgressTimeoutMinutes = 30,
    [int]$QueuedTimeoutMinutes = 5,
    [int]$MaxInfraRetries = 2,
    [switch]$DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$envDryRun = $env:DRY_RUN
if (-not $PSBoundParameters.ContainsKey('DryRun') -and $envDryRun) {
    $DryRun = @('1', 'true', 'yes', 'on') -contains $envDryRun.ToLowerInvariant()
}
$isDryRun = [bool]$DryRun

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..')
Set-Location $repoRoot

$logDirectory = Join-Path $repoRoot 'logs'
$logPath = Join-Path $logDirectory 'auto-fix-loop.log'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
if (-not (Test-Path -LiteralPath $logPath)) {
    New-Item -ItemType File -Path $logPath -Force | Out-Null
}

$requiredWorkflows = @('CI/CD Pipeline', 'Smoke Test E2E', 'Contract Check', 'security-recheck')
$dispatchableWorkflowFileByName = @{
    'CI/CD Pipeline'  = 'ci-cd.yaml'
    'Smoke Test E2E'  = 'smoke-test.yml'
    'Contract Check'  = 'contract-check.yml'
    'security-recheck' = 'security-recheck.yml'
}

$allowedPaths = @('.github/workflows/', 'scripts/', 'infra/', 'k8s/overlays/')
$infraRetryCounter = @{}
$errorFixCounter = @{}
$blockedErrorHashes = @{}

function Write-LoopLog {
    param(
        [string]$Level,
        [string]$Message,
        [string]$Category = 'general'
    )

    $timestamp = (Get-Date).ToString('s')
    $line = "[$timestamp] [$Level] [mode=$isDryRun] [category=$Category] $Message"
    Add-Content -Path $logPath -Value $line
    Write-Host $line
}

function Get-StringHash {
    param([string]$InputText)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($InputText)
        $hash = $sha.ComputeHash($bytes)
        return ([System.BitConverter]::ToString($hash)).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Invoke-Gh {
    param(
        [string[]]$Arguments,
        [int]$MaxAttempts = 3
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $output = & gh @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        Start-Sleep -Seconds 2

        if ($exitCode -eq 0) {
            return ($output | Out-String)
        }

        $text = ($output | Out-String)
        if ($text -match 'rate limit|API rate limit exceeded|secondary rate limit') {
            Write-LoopLog -Level 'WARN' -Category 'rate_limit' -Message "Rate limit hit for gh $($Arguments -join ' '), sleeping 60s (attempt $attempt/$MaxAttempts)."
            Start-Sleep -Seconds 60
            continue
        }

        if ($attempt -ge $MaxAttempts) {
            throw "gh $($Arguments -join ' ') failed after $MaxAttempts attempts. Output: $text"
        }

        Start-Sleep -Seconds (5 * $attempt)
    }

    throw 'Unexpected gh invocation failure.'
}

function Get-CurrentBranch {
    $branch = (& git branch --show-current 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Unable to determine current branch: $branch"
    }
    return $branch
}

function Get-Runs {
    param(
        [int]$Limit = 20,
        [string[]]$Fields = @('databaseId', 'workflowName', 'status', 'conclusion', 'headSha', 'createdAt', 'updatedAt')
    )

    $jsonFields = ($Fields -join ',')
    $json = Invoke-Gh -Arguments @('run', 'list', '--branch', $Branch, '--limit', "$Limit", '--json', $jsonFields)
    $runs = $json | ConvertFrom-Json
    if ($null -eq $runs) {
        return @()
    }
    return @($runs)
}

function Select-LatestHeadSha {
    $fastRuns = Get-Runs -Limit 1 -Fields @('headSha', 'createdAt', 'updatedAt')
    if (@($fastRuns).Count -eq 0) {
        return $null
    }

    $fastSha = $fastRuns[0].headSha
    $allRuns = Get-Runs -Limit 100 -Fields @('headSha', 'createdAt', 'updatedAt')
    if (@($allRuns).Count -eq 0) {
        return $fastSha
    }

    $latest = $allRuns |
        Sort-Object -Property @{ Expression = { [datetime]$_.createdAt }; Descending = $true }, @{ Expression = { [datetime]$_.updatedAt }; Descending = $true } |
        Select-Object -First 1

    if ($latest.headSha -ne $fastSha) {
        Write-LoopLog -Level 'WARN' -Category 'latest_sha' -Message "Fast-path SHA ($fastSha) differs from tie-safe SHA ($($latest.headSha)); using tie-safe result."
    }

    return $latest.headSha
}

function Get-WorkflowRunsForHeadSha {
    param([string]$HeadSha)

    $runs = Get-Runs -Limit 100
    $forHead = @($runs | Where-Object { $_.headSha -eq $HeadSha })

    $result = @{}
    foreach ($workflowName in $requiredWorkflows) {
        $latestPerWorkflow = $forHead |
            Where-Object { $_.workflowName -eq $workflowName } |
            Sort-Object -Property @{ Expression = { [datetime]$_.createdAt }; Descending = $true }, @{ Expression = { [datetime]$_.updatedAt }; Descending = $true } |
            Select-Object -First 1

        $result[$workflowName] = $latestPerWorkflow
    }

    return $result
}

function Get-RunAgeMinutes {
    param([object]$Run)

    if ($null -eq $Run) {
        return 0
    }

    $createdAt = [datetime]$Run.createdAt
    return [int]([datetime]::UtcNow - $createdAt.ToUniversalTime()).TotalMinutes
}

function Trigger-Workflow {
    param(
        [string]$WorkflowName,
        [string]$Reason,
        [string]$HeadSha,
        [string]$RunId = ''
    )

    $workflowFile = $dispatchableWorkflowFileByName[$WorkflowName]
    if (-not $workflowFile) {
        Write-LoopLog -Level 'WARN' -Category 'dispatch' -Message "Workflow '$WorkflowName' is not dispatchable. reason=$Reason"
        return
    }

    $retryKey = "$HeadSha|$WorkflowName|$Reason"
    if (-not $infraRetryCounter.ContainsKey($retryKey)) {
        $infraRetryCounter[$retryKey] = 0
    }

    if ($infraRetryCounter[$retryKey] -ge $MaxInfraRetries) {
        Write-LoopLog -Level 'WARN' -Category 'infra_timeout' -Message "Retry cap reached for $retryKey."
        return
    }

    $infraRetryCounter[$retryKey] = [int]$infraRetryCounter[$retryKey] + 1
    $attempt = $infraRetryCounter[$retryKey]

    if ($isDryRun) {
        Write-LoopLog -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: would cancel run '$RunId' and dispatch '$workflowFile' for reason=$Reason attempt=$attempt/$MaxInfraRetries."
        return
    }

    if ($RunId) {
        try {
            Invoke-Gh -Arguments @('run', 'cancel', $RunId) | Out-Null
            Write-LoopLog -Level 'INFO' -Category 'infra_timeout' -Message "Canceled run $RunId for workflow '$WorkflowName'."
        }
        catch {
            Write-LoopLog -Level 'WARN' -Category 'infra_timeout' -Message "Failed to cancel run ${RunId}: $($_.Exception.Message)"
        }
    }

    Invoke-Gh -Arguments @('workflow', 'run', $workflowFile, '--ref', $Branch) | Out-Null
    Write-LoopLog -Level 'INFO' -Category 'infra_timeout' -Message "Re-dispatched '$WorkflowName' via '$workflowFile' reason=$Reason attempt=$attempt/$MaxInfraRetries."
}

function Classify-RunFailure {
    param([string]$LogText)

    if ($LogText -match 'KUBE_CONFIG|NVD_API_KEY|AUTO_FIX_SECRET|secret_missing') {
        return 'secret_missing'
    }

    if ($LogText -match 'timed out|timeout|waiting for a runner|no available runner|The operation was canceled|context deadline exceeded') {
        return 'infra_timeout'
    }

    if ($LogText -match 'ECONNRESET|ETIMEDOUT|TLS|SSL|failed to download|Could not resolve host|503 Service Unavailable|429 Too Many Requests') {
        return 'flaky_test'
    }

    if ($LogText -match 'No such file or directory|not found|syntax error|unexpected token|YAML|mapping values are not allowed') {
        return 'syntax_or_path'
    }

    return 'unsupported'
}

function Update-FileWithTransform {
    param(
        [string]$RelativePath,
        [scriptblock]$Transform
    )

    $fullPath = Join-Path $repoRoot $RelativePath
    if (-not (Test-Path -LiteralPath $fullPath)) {
        return $false
    }

    $before = Get-Content -Path $fullPath -Raw
    $after = & $Transform $before
    if ($after -eq $before) {
        return $false
    }

    Set-Content -Path $fullPath -Value $after -NoNewline
    return $true
}

function Apply-FixRecipe {
    param(
        [string]$WorkflowName,
        [string]$Category
    )

    $summary = @()

    if ($Category -eq 'flaky_test' -and $WorkflowName -eq 'Contract Check') {
        $updated = Update-FileWithTransform -RelativePath '.github/workflows/contract-check.yml' -Transform {
            param($content)
            if ($content -match 'npm ci attempt') {
                return $content
            }
            return $content
        }
        if ($updated) {
            $summary += 'contract-check retry hardening'
        }
    }

    return [pscustomobject]@{
        Changed = (@($summary).Count -gt 0)
        Summary = ($summary -join ', ')
    }
}

function Assert-AllowedChangedFiles {
    $changedFiles = & git diff --name-only
    if ($LASTEXITCODE -ne 0) {
        throw 'Unable to list changed files.'
    }

    $invalidFiles = @()
    foreach ($file in @($changedFiles)) {
        $normalized = ($file -replace '\\', '/')
        $isAllowed = $false
        foreach ($prefix in $allowedPaths) {
            if ($normalized.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
                $isAllowed = $true
                break
            }
        }
        if (-not $isAllowed) {
            $invalidFiles += $normalized
        }
    }

    if (@($invalidFiles).Count -gt 0) {
        throw "Out-of-scope file changes detected: $($invalidFiles -join ', ')"
    }
}

function Commit-And-PushFix {
    param(
        [string]$WorkflowName,
        [string]$Category,
        [string]$Summary
    )

    if ($isDryRun) {
        Write-LoopLog -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: would git pull --rebase, commit, and push for workflow='$WorkflowName' category='$Category' summary='$Summary'."
        return $false
    }

    & git pull --rebase origin $Branch | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Write-LoopLog -Level 'WARN' -Category 'git_rebase' -Message "Rebase failed before commit. Skipping this fix attempt."
        return $false
    }

    & git diff --quiet
    if ($LASTEXITCODE -eq 0) {
        Write-LoopLog -Level 'INFO' -Category 'git' -Message 'No effective changes detected; skipping commit.'
        return $false
    }

    Assert-AllowedChangedFiles

    & git add .github/workflows scripts infra k8s/overlays
    if ($LASTEXITCODE -ne 0) {
        throw 'git add failed.'
    }

    $message = "auto: fix $WorkflowName - $Category"
    & git commit -m $message | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'git commit failed.'
    }

    & git push origin $Branch | Out-Null
    if ($LASTEXITCODE -ne 0) {
        throw 'git push failed.'
    }

    $commit = (& git rev-parse --short HEAD | Out-String).Trim()
    Write-LoopLog -Level 'INFO' -Category 'git' -Message "Committed and pushed $commit message='$message' summary='$Summary'."
    return $true
}

Write-LoopLog -Level 'INFO' -Message "Starting auto-fix loop on branch '$Branch'. PollSeconds=$PollSeconds InProgressTimeoutMinutes=$InProgressTimeoutMinutes QueuedTimeoutMinutes=$QueuedTimeoutMinutes MaxInfraRetries=$MaxInfraRetries"

while ($true) {
    try {
        $currentBranch = Get-CurrentBranch
        if ($currentBranch -ne $Branch) {
            throw "Branch guard failed. Current='$currentBranch', expected='$Branch'."
        }

        $latestHeadSha = Select-LatestHeadSha
        if (-not $latestHeadSha) {
            Write-LoopLog -Level 'WARN' -Category 'poll' -Message 'No workflow runs found yet. Sleeping before next poll.'
            Start-Sleep -Seconds $PollSeconds
            continue
        }

        $workflowRunsByName = Get-WorkflowRunsForHeadSha -HeadSha $latestHeadSha
        Write-LoopLog -Level 'INFO' -Category 'poll' -Message "Selected latest headSha=$latestHeadSha"

        $allSuccess = $true
        $hasPending = $false
        $failedCandidates = @()

        foreach ($workflowName in $requiredWorkflows) {
            $run = $workflowRunsByName[$workflowName]
            if ($null -eq $run) {
                $allSuccess = $false
                $hasPending = $true
                Write-LoopLog -Level 'WARN' -Category 'poll' -Message "Workflow '$workflowName' has no run for headSha=$latestHeadSha"
                Trigger-Workflow -WorkflowName $workflowName -Reason 'missing_run' -HeadSha $latestHeadSha
                continue
            }

            $status = "$($run.status)"
            $conclusion = "$($run.conclusion)"
            $runId = "$($run.databaseId)"
            $ageMinutes = Get-RunAgeMinutes -Run $run
            Write-LoopLog -Level 'INFO' -Category 'poll' -Message "Workflow '$workflowName' run=$runId status=$status conclusion=$conclusion age=${ageMinutes}m"

            if ($status -ne 'completed') {
                $allSuccess = $false
                $hasPending = $true

                if ($status -eq 'queued' -and $ageMinutes -gt $QueuedTimeoutMinutes) {
                    Trigger-Workflow -WorkflowName $workflowName -Reason 'queued_stuck' -HeadSha $latestHeadSha -RunId $runId
                }

                if ($status -eq 'in_progress' -and $ageMinutes -gt $InProgressTimeoutMinutes) {
                    Trigger-Workflow -WorkflowName $workflowName -Reason 'infra_timeout' -HeadSha $latestHeadSha -RunId $runId
                }

                continue
            }

            if ($conclusion -ne 'success') {
                $allSuccess = $false
                if ($conclusion -eq 'failure') {
                    $failedCandidates += $run
                }
            }
        }

        if ($allSuccess) {
            Write-LoopLog -Level 'INFO' -Category 'success' -Message "All required workflows are success on latest headSha=$latestHeadSha. Exiting loop."
            break
        }

        if (@($failedCandidates).Count -gt 0) {
            $failedRun = $failedCandidates |
                Sort-Object -Property @{ Expression = { [datetime]$_.updatedAt }; Descending = $true } |
                Select-Object -First 1

            $failedRunId = "$($failedRun.databaseId)"
            $failedWorkflow = "$($failedRun.workflowName)"
            Write-LoopLog -Level 'WARN' -Category 'failure' -Message "Handling failed run id=$failedRunId workflow='$failedWorkflow'"

            $failedLog = Invoke-Gh -Arguments @('run', 'view', $failedRunId, '--log-failed')
            $normalizedLog = (($failedLog -split "`r?`n") | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 200) -join "`n"
            $category = Classify-RunFailure -LogText $normalizedLog
            $errorHash = Get-StringHash -InputText "$failedWorkflow|$category|$normalizedLog"

            if ($category -eq 'secret_missing') {
                Write-LoopLog -Level 'WARN' -Category 'secret_missing' -Message "Missing secret detected for workflow='$failedWorkflow'. Waiting for operator action."
                Start-Sleep -Seconds $PollSeconds
                continue
            }

            if ($blockedErrorHashes.ContainsKey($errorHash)) {
                Write-LoopLog -Level 'WARN' -Category 'blocked' -Message "Error hash already blocked=$errorHash workflow='$failedWorkflow'."
                Start-Sleep -Seconds $PollSeconds
                continue
            }

            if (-not $errorFixCounter.ContainsKey($errorHash)) {
                $errorFixCounter[$errorHash] = 0
            }

            $errorFixCounter[$errorHash] = [int]$errorFixCounter[$errorHash] + 1
            $fixCount = $errorFixCounter[$errorHash]
            Write-LoopLog -Level 'INFO' -Category $category -Message "Classified failure workflow='$failedWorkflow' run=$failedRunId hash=$errorHash count=$fixCount"

            if ($fixCount -gt 5) {
                $blockedErrorHashes[$errorHash] = $true
                Write-LoopLog -Level 'WARN' -Category 'blocked' -Message "Marked blocked after >5 attempts hash=$errorHash workflow='$failedWorkflow'."
                Start-Sleep -Seconds $PollSeconds
                continue
            }

            if ($category -eq 'infra_timeout') {
                Trigger-Workflow -WorkflowName $failedWorkflow -Reason 'infra_timeout_failure' -HeadSha $latestHeadSha -RunId $failedRunId
                continue
            }

            $recipeResult = Apply-FixRecipe -WorkflowName $failedWorkflow -Category $category
            if (-not $recipeResult.Changed) {
                Write-LoopLog -Level 'WARN' -Category $category -Message "No code recipe changes produced for workflow='$failedWorkflow'."
                if ($category -eq 'flaky_test') {
                    $backoffSeconds = [Math]::Min(60, [Math]::Pow(2, [Math]::Min($fixCount, 6)))
                    Write-LoopLog -Level 'INFO' -Category 'flaky_test' -Message "Applying backoff=$backoffSeconds seconds before re-dispatch."
                    Start-Sleep -Seconds $backoffSeconds
                    Trigger-Workflow -WorkflowName $failedWorkflow -Reason 'flaky_retry' -HeadSha $latestHeadSha -RunId $failedRunId
                    continue
                }
                Start-Sleep -Seconds $PollSeconds
                continue
            }

            $committed = Commit-And-PushFix -WorkflowName $failedWorkflow -Category $category -Summary $recipeResult.Summary
            if ($committed) {
                Write-LoopLog -Level 'INFO' -Category 'repoll' -Message 'Fix committed; re-polling immediately.'
                continue
            }
        }

        if ($hasPending) {
            Write-LoopLog -Level 'INFO' -Category 'poll' -Message "Pending workflows detected. Sleeping $PollSeconds seconds before next poll."
        }
        else {
            Write-LoopLog -Level 'INFO' -Category 'poll' -Message "No actionable failures found. Sleeping $PollSeconds seconds."
        }

        Start-Sleep -Seconds $PollSeconds
    }
    catch {
        Write-LoopLog -Level 'ERROR' -Category 'loop' -Message "Unhandled loop error: $($_.Exception.Message) | stack=$($_.ScriptStackTrace)"
        Start-Sleep -Seconds $PollSeconds
    }
}
