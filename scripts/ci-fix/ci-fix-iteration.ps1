param(
    [string]$TargetBranch = 'main',
    [string]$SourceBranch = 'production-ready',
    [int]$PollSeconds = 30,
    [int]$LockTimeoutMinutes = 30,
    [int]$MaxIterations = 3,
    [switch]$EnableAutoMerge,
    [switch]$DryRun
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '../..')
Set-Location $repoRoot

$envDryRun = $env:DRY_RUN
if (-not $PSBoundParameters.ContainsKey('DryRun') -and $envDryRun) {
    $DryRun = @('1', 'true', 'yes', 'on') -contains $envDryRun.ToLowerInvariant()
}

. (Join-Path $repoRoot 'scripts/ci-auto-fix-loop.ps1')

$context = New-CiFixContext -RepoRoot $repoRoot -IsDryRun ([bool]$DryRun)
$lockPath = ''
$tempBranch = ''
$pullRequestNumber = 0

function Get-RepoOwnerAndName {
    param([pscustomobject]$Context)

    $repo = Invoke-GhCommand -Context $Context -Arguments @('repo', 'view', '--json', 'nameWithOwner')
    $nameWithOwner = ($repo | ConvertFrom-Json).nameWithOwner
    if (-not $nameWithOwner -or $nameWithOwner -notmatch '/') {
        throw 'Unable to resolve owner/repo from gh repo view.'
    }

    $parts = $nameWithOwner.Split('/')
    return [pscustomobject]@{
        Owner = $parts[0]
        Repo  = $parts[1]
    }
}

try {
    Write-CiFixLog -Context $context -Level 'INFO' -Category 'start' -Message "Starting post-merge iteration for target=$TargetBranch source=$SourceBranch"

    $repoInfo = Get-RepoOwnerAndName -Context $context
    $mergeSha = Get-LatestMergeCommitSha -Context $context -TargetBranch $TargetBranch

    $runId = if ($env:GITHUB_RUN_ID) { $env:GITHUB_RUN_ID } else { 'local' }
    $lockResult = New-MergeLock -Context $context -MergeSha $mergeSha -TimeoutMinutes $LockTimeoutMinutes -RunId $runId
    if (-not $lockResult.Acquired) {
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'lock' -Message "Skip run for mergeSha=$mergeSha because it is already processing."
        exit 0
    }

    $lockPath = $lockResult.LockPath
    Write-CiFixLog -Context $context -Level 'INFO' -Category 'lock' -Message "Acquired lock for mergeSha=$mergeSha path=$lockPath"

    Invoke-PreflightChecks -Context $context -Owner $repoInfo.Owner -Repo $repoInfo.Repo -TargetBranch $TargetBranch
    Write-CiFixLog -Context $context -Level 'INFO' -Category 'preflight' -Message 'Preflight checks passed.'

    $requiredWorkflows = Get-RequiredWorkflowNames -Context $context -Owner $repoInfo.Owner -Repo $repoInfo.Repo -TargetBranch $TargetBranch
    Write-CiFixLog -Context $context -Level 'INFO' -Category 'required_checks' -Message "Required checks: $($requiredWorkflows -join ', ')"

    $mainRuns = Get-CheckRunsForCommit -Context $context -Owner $repoInfo.Owner -Repo $repoInfo.Repo -CommitSha $mergeSha
    $mainSummary = Get-WorkflowStatusSummary -Context $context -Runs $mainRuns -RequiredWorkflowNames $requiredWorkflows
    if (@($mainSummary.Failed).Count -eq 0 -and @($mainSummary.Pending).Count -eq 0) {
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'success' -Message "All required workflows already green for mergeSha=$mergeSha"
        exit 0
    }

    $tempBranch = New-TemporaryFixBranch -Context $context -TargetBranch $TargetBranch
    Push-CurrentBranch -Context $context -BranchName $tempBranch

    if ($context.IsDryRun) {
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: simulated temporary branch creation ($tempBranch), recipe application, workflow re-check, and PR creation."
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: detected failed checks=$(@($mainSummary.Failed).Count), pending checks=$(@($mainSummary.Pending).Count) for mergeSha=$mergeSha"
        exit 0
    }

    for ($iteration = 1; $iteration -le $MaxIterations; $iteration++) {
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'iteration' -Message "Iteration $iteration/$MaxIterations for mergeSha=$mergeSha"

        $runSet = if ($iteration -eq 1) {
            $mainRuns
        }
        else {
            $headSha = (Invoke-GitCommand -Context $context -Arguments @('rev-parse', 'HEAD')).Output.Trim()
            Get-WorkflowRuns -Context $context -Branch $tempBranch -CommitSha $headSha
        }

        $summary = Get-WorkflowStatusSummary -Context $context -Runs $runSet -RequiredWorkflowNames $requiredWorkflows
        $allDone = (@($summary.Failed).Count -eq 0 -and @($summary.Pending).Count -eq 0)

        if ($allDone -and $iteration -gt 1) {
            $rebased = Sync-BranchWithLatestMain -Context $context -TemporaryBranch $tempBranch -TargetBranch $TargetBranch
            if ($rebased) {
                $headAfterRebase = (Invoke-GitCommand -Context $context -Arguments @('rev-parse', 'HEAD')).Output.Trim()
                foreach ($workflow in $requiredWorkflows) {
                    Invoke-DispatchWorkflowRun -Context $context -WorkflowName $workflow -RefBranch $tempBranch
                }

                $summary = Wait-RequiredWorkflows -Context $context -Branch $tempBranch -CommitSha $headAfterRebase -RequiredWorkflowNames $requiredWorkflows -PollSeconds $PollSeconds
                if (@($summary.Failed).Count -gt 0 -or @($summary.Pending).Count -gt 0) {
                    Write-CiFixLog -Context $context -Level 'WARN' -Category 'rebase_gate' -Message 'Checks failed after rebase gate. Continue iterations.'
                    continue
                }
            }

            $prBodyPath = Join-Path $repoRoot 'logs/ci-fix/pr-body.md'
            $prBody = @(
                '# Post-Merge CI Auto-Fix Report'
                ''
                "- Merge SHA: $mergeSha"
                "- Source branch: $SourceBranch"
                "- Target branch: $TargetBranch"
                "- Temporary branch: $tempBranch"
            ) -join "`n"
            Set-Content -Path $prBodyPath -Value $prBody

            $pullRequestNumber = New-OrUpdatePullRequest -Context $context -TargetBranch $TargetBranch -HeadBranch $tempBranch -MergeSha $mergeSha -BodyPath $prBodyPath
            if ($EnableAutoMerge) {
                Enable-PullRequestAutoMerge -Context $context -PullRequestNumber $pullRequestNumber -MergeMethod 'squash'
            }

            Write-CiFixLog -Context $context -Level 'INFO' -Category 'success' -Message "PR ready: #$pullRequestNumber"
            exit 0
        }

        if (@($summary.Failed).Count -eq 0 -and @($summary.Pending).Count -gt 0) {
            $headShaWait = (Invoke-GitCommand -Context $context -Arguments @('rev-parse', 'HEAD')).Output.Trim()
            $summary = Wait-RequiredWorkflows -Context $context -Branch $tempBranch -CommitSha $headShaWait -RequiredWorkflowNames $requiredWorkflows -PollSeconds $PollSeconds
            if (@($summary.Failed).Count -eq 0 -and @($summary.Pending).Count -eq 0) {
                continue
            }
        }

        $failedRun = $summary.Failed |
            Sort-Object -Property @{ Expression = { [datetime]$_.updatedAt }; Descending = $true } |
            Select-Object -First 1

        if ($null -eq $failedRun) {
            Write-CiFixLog -Context $context -Level 'WARN' -Category 'iteration' -Message 'No failed run selected; retry next iteration.'
            continue
        }

        $runIdStr = "$($failedRun.databaseId)"
        $workflowName = "$($failedRun.workflowName)"
        $logText = Get-FailedRunLog -Context $context -RunId $runIdStr
        $normalizedLog = (($logText -split "`r?`n") | Where-Object { $_.Trim().Length -gt 0 } | Select-Object -First 200) -join "`n"
        $category = Get-RunFailureCategory -LogText $normalizedLog

        Write-CiFixLog -Context $context -Level 'INFO' -Category 'classification' -Message "Run $runIdStr workflow=$workflowName category=$category"

        $recipeResult = Invoke-MergeFixRecipe -Context $context -Category $category -SourceBranch $SourceBranch -NormalizedLog $normalizedLog
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'recipe' -Message $recipeResult.Message

        if ($recipeResult.Handoff) {
            $handoffLines = @(
                '# Merge Handoff Report'
                ''
                "- Merge SHA: $mergeSha"
                "- Iteration: $iteration"
                "- Workflow: $workflowName"
                "- Category: $category"
                "- Message: $($recipeResult.Message)"
            ) -join "`n"
            Write-MarkdownReport -Context $context -RelativePath 'logs/ci-fix/merge-handoff-report.md' -Content $handoffLines
            throw 'Manual handoff required.'
        }

        if (-not $recipeResult.Changed) {
            foreach ($wf in @($summary.Failed | Select-Object -ExpandProperty workflowName -Unique)) {
                Invoke-DispatchWorkflowRun -Context $context -WorkflowName $wf -RefBranch $tempBranch
            }
            continue
        }

        Push-CurrentBranch -Context $context -BranchName $tempBranch

        foreach ($wf in @($summary.Failed | Select-Object -ExpandProperty workflowName -Unique)) {
            Invoke-DispatchWorkflowRun -Context $context -WorkflowName $wf -RefBranch $tempBranch
        }

        $headSha = (Invoke-GitCommand -Context $context -Arguments @('rev-parse', 'HEAD')).Output.Trim()
        $latest = Wait-RequiredWorkflows -Context $context -Branch $tempBranch -CommitSha $headSha -RequiredWorkflowNames $requiredWorkflows -PollSeconds $PollSeconds
        if (@($latest.Failed).Count -eq 0 -and @($latest.Pending).Count -eq 0) {
            continue
        }
    }

    $maxAttemptComment = 'Auto-fix reached max attempts (3); manual intervention required.'
    if ($pullRequestNumber -gt 0) {
        Close-PullRequestWithComment -Context $context -PullRequestNumber $pullRequestNumber -Comment $maxAttemptComment
    }

    $handoff = @(
        '# Merge Handoff Report'
        ''
        "- Merge SHA: $mergeSha"
        "- Status: failed_after_max_attempts"
        "- Target branch: $TargetBranch"
        "- Source branch: $SourceBranch"
        "- Temporary branch: $tempBranch"
        "- Pull Request: $pullRequestNumber"
    ) -join "`n"
    Write-MarkdownReport -Context $context -RelativePath 'logs/ci-fix/merge-handoff-report.md' -Content $handoff

    throw 'Reached max iterations without green checks.'
}
finally {
    Remove-MergeLock -LockPath $lockPath
    if ($lockPath) {
        Write-CiFixLog -Context $context -Level 'INFO' -Category 'lock' -Message "Released lock path=$lockPath"
    }
}
