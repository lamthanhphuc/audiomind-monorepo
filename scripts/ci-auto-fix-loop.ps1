Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$script:DefaultRequiredWorkflows = @('CI', 'Smoke Test E2E', 'Contract Check', 'security-recheck')
$script:DispatchableWorkflowFileByName = @{
    'CI'               = 'ci.yml'
    'Smoke Test E2E'   = 'smoke-test.yml'
    'Contract Check'   = 'contract-check.yml'
    'security-recheck' = 'security-recheck.yml'
}

function New-CiFixContext {
    param(
        [string]$RepoRoot,
        [bool]$IsDryRun,
        [string]$LogPath = ''
    )

    if (-not $RepoRoot) {
        $RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
    }

    $logDir = Join-Path $RepoRoot 'logs/ci-fix'
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null

    if (-not $LogPath) {
        $LogPath = Join-Path $logDir 'post-merge-auto-fix.log'
    }

    if (-not (Test-Path -LiteralPath $LogPath)) {
        New-Item -ItemType File -Path $LogPath -Force | Out-Null
    }

    return [pscustomobject]@{
        RepoRoot = $RepoRoot
        IsDryRun = $IsDryRun
        LogPath  = $LogPath
    }
}

function Write-CiFixLog {
    param(
        [pscustomobject]$Context,
        [string]$Level,
        [string]$Message,
        [string]$Category = 'general'
    )

    $timestamp = (Get-Date).ToUniversalTime().ToString('s')
    $line = "[$timestamp] [$Level] [dry_run=$($Context.IsDryRun)] [category=$Category] $Message"
    Add-Content -Path $Context.LogPath -Value $line
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

function Invoke-GhCommand {
    param(
        [pscustomobject]$Context,
        [string[]]$Arguments,
        [int]$MaxAttempts = 3
    )

    for ($attempt = 1; $attempt -le $MaxAttempts; $attempt++) {
        $output = & gh @Arguments 2>&1
        $exitCode = $LASTEXITCODE
        if ($exitCode -eq 0) {
            return ($output | Out-String)
        }

        $text = ($output | Out-String)
        if ($text -match 'rate limit|API rate limit exceeded|secondary rate limit') {
            Write-CiFixLog -Context $Context -Level 'WARN' -Category 'rate_limit' -Message "Rate limit for gh $($Arguments -join ' ') on attempt $attempt/$MaxAttempts; backing off 60s."
            Start-Sleep -Seconds 60
            continue
        }

        if ($attempt -ge $MaxAttempts) {
            throw "gh $($Arguments -join ' ') failed after $MaxAttempts attempts. Output: $text"
        }

        Start-Sleep -Seconds (3 * $attempt)
    }

    throw 'Unexpected gh command failure.'
}

function Get-GhTokenScopes {
    param([string]$AuthStatusText)

    $scopeLine = ($AuthStatusText -split "`r?`n" | Where-Object { $_ -match 'Token scopes:' } | Select-Object -First 1)
    if (-not $scopeLine) {
        return @()
    }

    $match = [regex]::Match($scopeLine, "Token scopes:\s*'(?<scopes>.+)'$")
    if (-not $match.Success) {
        return @()
    }

    return @($match.Groups['scopes'].Value -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
}

function Get-GhApiScopes {
    param([pscustomobject]$Context)

    try {
        $raw = Invoke-GhCommand -Context $Context -Arguments @('api', '-i', 'user')
        $headerLine = ($raw -split "`r?`n" | Where-Object { $_ -match '^X-Oauth-Scopes:' } | Select-Object -First 1)
        if (-not $headerLine) {
            return @()
        }

        $scopeText = ($headerLine -replace '^X-Oauth-Scopes:\s*', '').Trim()
        if (-not $scopeText) {
            return @()
        }

        return @($scopeText -split ',' | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    }
    catch {
        Write-CiFixLog -Context $Context -Level 'WARN' -Category 'preflight' -Message "Unable to parse API scopes: $($_.Exception.Message)"
        return @()
    }
}

function Invoke-GitCommand {
    param(
        [pscustomobject]$Context,
        [string[]]$Arguments,
        [switch]$AllowFailure
    )

    $output = & git @Arguments 2>&1
    $exitCode = $LASTEXITCODE
    if (-not $AllowFailure -and $exitCode -ne 0) {
        throw "git $($Arguments -join ' ') failed. Output: $($output | Out-String)"
    }

    return [pscustomobject]@{
        ExitCode = $exitCode
        Output   = ($output | Out-String)
    }
}

function Get-LatestMergeCommitSha {
    param(
        [pscustomobject]$Context,
        [string]$TargetBranch = 'main'
    )

    Invoke-GitCommand -Context $Context -Arguments @('fetch', 'origin', $TargetBranch) | Out-Null
    $result = Invoke-GitCommand -Context $Context -Arguments @('log', "origin/$TargetBranch", '--merges', '-n', '1', '--pretty=format:%H')
    $sha = $result.Output.Trim()
    if (-not $sha) {
        throw "No merge commit found on origin/$TargetBranch"
    }
    return $sha
}

function Get-RequiredWorkflowNames {
    param(
        [pscustomobject]$Context,
        [string]$Owner,
        [string]$Repo,
        [string]$TargetBranch = 'main'
    )

    try {
        $json = Invoke-GhCommand -Context $Context -Arguments @('api', "repos/$Owner/$Repo/branches/$TargetBranch/protection")
        $protection = $json | ConvertFrom-Json
        $contexts = @($protection.required_status_checks.contexts)
        if (@($contexts).Count -gt 0) {
            return @($contexts)
        }
    }
    catch {
        Write-CiFixLog -Context $Context -Level 'WARN' -Category 'required_checks' -Message "Falling back to default workflow list: $($_.Exception.Message)"
    }

    return $script:DefaultRequiredWorkflows
}

function Get-WorkflowRuns {
    param(
        [pscustomobject]$Context,
        [string]$Branch,
        [string]$CommitSha,
        [int]$Limit = 100
    )

    $jsonFields = 'databaseId,workflowName,status,conclusion,headSha,createdAt,updatedAt,url'
    $json = Invoke-GhCommand -Context $Context -Arguments @('run', 'list', '--branch', $Branch, '--commit', $CommitSha, '--limit', "$Limit", '--json', $jsonFields)
    $runs = $json | ConvertFrom-Json
    if ($null -eq $runs) {
        return @()
    }
    return @($runs)
}

function Get-CheckRunsForCommit {
    param(
        [pscustomobject]$Context,
        [string]$Owner,
        [string]$Repo,
        [string]$CommitSha
    )

    $json = Invoke-GhCommand -Context $Context -Arguments @('api', "repos/$Owner/$Repo/commits/$CommitSha/check-runs")
    $payload = $json | ConvertFrom-Json
    if ($null -eq $payload -or $null -eq $payload.check_runs) {
        return @()
    }

    $result = @()
    foreach ($check in @($payload.check_runs)) {
        $runId = ''
        $detailsUrl = [string]$check.details_url
        if ($detailsUrl -match '/actions/runs/(\d+)') {
            $runId = $Matches[1]
        }

        $result += [pscustomobject]@{
            databaseId   = $runId
            checkRunId   = [string]$check.id
            name         = [string]$check.name
            status       = [string]$check.status
            conclusion   = [string]$check.conclusion
            headSha      = [string]$check.head_sha
            createdAt    = [string]$check.started_at
            updatedAt    = if ($check.completed_at) { [string]$check.completed_at } else { [string]$check.started_at }
            url          = [string]$check.details_url
            workflowName = [string]$check.name
        }
    }

    return $result
}

function Get-WorkflowStatusSummary {
    param(
        [pscustomobject]$Context,
        [object[]]$Runs,
        [string[]]$RequiredWorkflowNames
    )

    $failed = @()
    $pending = @()

    foreach ($name in $RequiredWorkflowNames) {
        $match = $Runs |
            Where-Object {
                $itemName = ''
                try { $itemName = [string]$_.workflowName } catch { $itemName = '' }
                if (-not $itemName) {
                    try { $itemName = [string]$_.name } catch { $itemName = '' }
                }
                $itemName -eq $name
            } |
            Sort-Object -Property @{ Expression = {
                    $dateText = ''
                    try { $dateText = [string]$_.updatedAt } catch { $dateText = '' }
                    if (-not $dateText) {
                        try { $dateText = [string]$_.createdAt } catch { $dateText = '' }
                    }
                    if (-not $dateText) {
                        return [datetime]::MinValue
                    }
                    try {
                        return [datetime]$dateText
                    }
                    catch {
                        return [datetime]::MinValue
                    }
                }; Descending = $true } |
            Select-Object -First 1

        if ($null -eq $match) {
            $pending += [pscustomobject]@{ WorkflowName = $name; Reason = 'missing_run' }
            continue
        }

        $status = "$($match.status)"
        $conclusion = "$($match.conclusion)"

        if ($status -ne 'completed') {
            $pending += $match
            continue
        }

        if (@('failure', 'timed_out', 'cancelled') -contains $conclusion) {
            $failed += $match
        }
    }

    return [pscustomobject]@{
        Failed  = @($failed)
        Pending = @($pending)
    }
}

function Get-FailedRunLog {
    param(
        [pscustomobject]$Context,
        [string]$RunId
    )

    try {
        return Invoke-GhCommand -Context $Context -Arguments @('run', 'view', $RunId, '--log-failed')
    }
    catch {
        Write-CiFixLog -Context $Context -Level 'WARN' -Category 'log' -Message "Falling back to full log for run $RunId."
        return Invoke-GhCommand -Context $Context -Arguments @('run', 'view', $RunId, '--log')
    }
}

function Get-MissingWorkflowFileFromLog {
    param([string]$LogText)

    $workflowMatches = [regex]::Matches($LogText, '\.github/workflows/([A-Za-z0-9_.-]+\.ya?ml)')
    if ($workflowMatches.Count -eq 0) {
        return $null
    }

    return $workflowMatches[0].Groups[1].Value
}

function Get-MissingWorkflowNameFromLog {
    param([string]$LogText)

    $missingFile = Get-MissingWorkflowFileFromLog -LogText $LogText
    if (-not $missingFile) {
        return $null
    }

    return [System.IO.Path]::GetFileNameWithoutExtension($missingFile)
}

function Get-RunFailureCategory {
    param([string]$LogText)

    if ($LogText -match 'Merge conflict in package-lock\.json|CONFLICT \(content\): Merge conflict in package-lock\.json') {
        return 'lockfile-conflict'
    }

    if ($LogText -match 'Workflow does not exist|workflow file was not found|Could not find workflow') {
        return 'missing-workflow'
    }

    if ($LogText -match 'Secret not available|secret_missing|AUTO_FIX_SECRET|NVD_API_KEY|KUBE_CONFIG') {
        return 'secret-missing'
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

function Resolve-RecipeTemplate {
    param(
        [string]$Value,
        [hashtable]$Variables
    )

    if ($null -eq $Value) {
        return $null
    }

    $resolved = $Value
    foreach ($key in $Variables.Keys) {
        $resolved = $resolved.Replace("`${$key}", [string]$Variables[$key])
    }
    return $resolved
}

function Get-RecipeSet {
    param([pscustomobject]$Context)

    $path = Join-Path $Context.RepoRoot 'scripts/ci-fix/recipes.json'
    if (-not (Test-Path -LiteralPath $path)) {
        throw "Recipe configuration not found: $path"
    }

    $raw = Get-Content -Path $path -Raw
    $config = $raw | ConvertFrom-Json
    if ($null -eq $config -or $null -eq $config.recipes) {
        throw "Invalid recipe configuration: $path"
    }

    return @($config.recipes)
}

function Invoke-RecipeByName {
    param(
        [pscustomobject]$Context,
        [string]$RecipeName,
        [string]$SourceBranch,
        [hashtable]$Variables
    )

    $recipes = Get-RecipeSet -Context $Context
    $recipe = @($recipes | Where-Object { $_.name -eq $RecipeName } | Select-Object -First 1)
    if (@($recipe).Count -eq 0) {
        return [pscustomobject]@{ Changed = $false; Message = "No recipe found for $RecipeName"; Handoff = $false }
    }

    $selected = $recipe[0]
    $changed = $false

    foreach ($action in @($selected.actions)) {
        $type = [string]$action.type
        switch ($type) {
            'command' {
                $cmd = Resolve-RecipeTemplate -Value ([string]$action.cmd) -Variables $Variables
                $actionArgs = @()
                foreach ($arg in @($action.args)) {
                    $actionArgs += Resolve-RecipeTemplate -Value ([string]$arg) -Variables $Variables
                }

                if ($Context.IsDryRun) {
                    Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: command $cmd $($actionArgs -join ' ')"
                }
                else {
                    & $cmd @actionArgs
                    if ($LASTEXITCODE -ne 0) {
                        throw "Command action failed: $cmd $($actionArgs -join ' ')"
                    }
                }
                $changed = $true
            }
            'git' {
                $gitCmd = Resolve-RecipeTemplate -Value ([string]$action.cmd) -Variables $Variables
                $gitArgs = @($gitCmd)
                foreach ($arg in @($action.args)) {
                    $gitArgs += Resolve-RecipeTemplate -Value ([string]$arg) -Variables $Variables
                }

                if ($Context.IsDryRun) {
                    Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: git $($gitArgs -join ' ')"
                }
                else {
                    Invoke-GitCommand -Context $Context -Arguments $gitArgs | Out-Null
                }
                $changed = $true
            }
            'checkout-file' {
                $sourceRef = Resolve-RecipeTemplate -Value ([string]$action.source) -Variables $Variables
                if ($sourceRef -eq 'origin/production-ready') {
                    $sourceRef = "origin/$SourceBranch"
                }
                $checkoutPath = Resolve-RecipeTemplate -Value ([string]$action.path) -Variables $Variables

                if ($Context.IsDryRun) {
                    Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: git checkout $sourceRef -- $checkoutPath"
                }
                else {
                    Invoke-GitCommand -Context $Context -Arguments @('checkout', $sourceRef, '--', $checkoutPath) | Out-Null
                }
                $changed = $true
            }
            'commit' {
                $message = Resolve-RecipeTemplate -Value ([string]$action.message) -Variables $Variables
                if ($Context.IsDryRun) {
                    Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: git commit -m $message"
                }
                else {
                    Invoke-GitCommand -Context $Context -Arguments @('commit', '-m', $message) | Out-Null
                }
                $changed = $true
            }
            'handoff' {
                $reason = Resolve-RecipeTemplate -Value ([string]$action.reason) -Variables $Variables
                return [pscustomobject]@{ Changed = $false; Message = $reason; Handoff = $true }
            }
            default {
                return [pscustomobject]@{ Changed = $false; Message = "Unsupported action type: $type"; Handoff = $true }
            }
        }
    }

    return [pscustomobject]@{ Changed = $changed; Message = "Applied recipe $RecipeName"; Handoff = $false }
}

function Invoke-MergeFixRecipe {
    param(
        [pscustomobject]$Context,
        [string]$Category,
        [string]$SourceBranch,
        [string]$NormalizedLog
    )

    $variables = @{}
    $missingWorkflow = Get-MissingWorkflowNameFromLog -LogText $NormalizedLog
    if ($missingWorkflow) {
        $variables['workflow'] = $missingWorkflow
    }

    return Invoke-RecipeByName -Context $Context -RecipeName $Category -SourceBranch $SourceBranch -Variables $variables
}

function Push-CurrentBranch {
    param(
        [pscustomobject]$Context,
        [string]$BranchName,
        [switch]$ForceWithLease
    )

    if ($Context.IsDryRun) {
        Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: would push branch $BranchName"
        return
    }

    $pushArgs = @('push', '-u', 'origin', $BranchName)
    if ($ForceWithLease) {
        $pushArgs = @('push', '--force-with-lease', '-u', 'origin', $BranchName)
    }

    Invoke-GitCommand -Context $Context -Arguments $pushArgs | Out-Null
}

function Invoke-DispatchWorkflowRun {
    param(
        [pscustomobject]$Context,
        [string]$WorkflowName,
        [string]$RefBranch
    )

    $workflowFile = $script:DispatchableWorkflowFileByName[$WorkflowName]
    if (-not $workflowFile) {
        Write-CiFixLog -Context $Context -Level 'WARN' -Category 'dispatch' -Message "Workflow $WorkflowName is not dispatchable."
        return
    }

    if ($Context.IsDryRun) {
        Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: would dispatch $workflowFile on $RefBranch"
        return
    }

    Invoke-GhCommand -Context $Context -Arguments @('workflow', 'run', $workflowFile, '--ref', $RefBranch) | Out-Null
}

function Wait-RequiredWorkflows {
    param(
        [pscustomobject]$Context,
        [string]$Branch,
        [string]$CommitSha,
        [string[]]$RequiredWorkflowNames,
        [int]$PollSeconds = 20,
        [int]$TimeoutMinutes = 30
    )

    $start = Get-Date
    while ($true) {
        $runs = Get-WorkflowRuns -Context $Context -Branch $Branch -CommitSha $CommitSha
        $summary = Get-WorkflowStatusSummary -Context $Context -Runs $runs -RequiredWorkflowNames $RequiredWorkflowNames

        if (@($summary.Pending).Count -eq 0) {
            return $summary
        }

        $elapsed = (Get-Date) - $start
        if ($elapsed.TotalMinutes -ge $TimeoutMinutes) {
            Write-CiFixLog -Context $Context -Level 'WARN' -Category 'poll' -Message "Timeout while waiting required workflows on $Branch/$CommitSha"
            return $summary
        }

        Start-Sleep -Seconds $PollSeconds
    }
}

function Sync-BranchWithLatestMain {
    param(
        [pscustomobject]$Context,
        [string]$TemporaryBranch,
        [string]$TargetBranch = 'main'
    )

    Invoke-GitCommand -Context $Context -Arguments @('fetch', 'origin', $TargetBranch) | Out-Null
    $headBefore = (Invoke-GitCommand -Context $Context -Arguments @('rev-parse', 'HEAD')).Output.Trim()
    $baseBefore = (Invoke-GitCommand -Context $Context -Arguments @('merge-base', 'HEAD', "origin/$TargetBranch")).Output.Trim()
    $targetHead = (Invoke-GitCommand -Context $Context -Arguments @('rev-parse', "origin/$TargetBranch")).Output.Trim()

    if ($baseBefore -eq $targetHead) {
        return $false
    }

    if ($Context.IsDryRun) {
        Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: would rebase $TemporaryBranch onto origin/$TargetBranch"
        return $true
    }

    Invoke-GitCommand -Context $Context -Arguments @('rebase', "origin/$TargetBranch") | Out-Null
    $headAfter = (Invoke-GitCommand -Context $Context -Arguments @('rev-parse', 'HEAD')).Output.Trim()
    $rebased = ($headAfter -ne $headBefore)
    if ($rebased) {
        Push-CurrentBranch -Context $Context -BranchName $TemporaryBranch -ForceWithLease
    }

    return $rebased
}

function Write-MarkdownReport {
    param(
        [pscustomobject]$Context,
        [string]$RelativePath,
        [string]$Content
    )

    $fullPath = Join-Path $Context.RepoRoot $RelativePath
    $parent = Split-Path -Parent $fullPath
    New-Item -ItemType Directory -Path $parent -Force | Out-Null
    Set-Content -Path $fullPath -Value $Content
}

function Invoke-PreflightChecks {
    param(
        [pscustomobject]$Context,
        [string]$Owner,
        [string]$Repo,
        [string]$TargetBranch = 'main'
    )

    $failures = @()

    $authResult = & gh auth status 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $failures += 'gh auth status failed'
    }

    $actualScopes = Get-GhApiScopes -Context $Context
    if (@($actualScopes).Count -eq 0) {
        $actualScopes = Get-GhTokenScopes -AuthStatusText $authResult
    }
    $requiredScopes = @('repo', 'workflow', 'read:org')

    foreach ($scope in $requiredScopes) {
        $hasScope = $actualScopes -contains $scope
        if (-not $hasScope -and $scope -eq 'read:org') {
            # admin:org is a superset and satisfies read access for org metadata.
            $hasScope = $actualScopes -contains 'admin:org'
        }

        if (-not $hasScope) {
            $failures += "missing scope: $scope"
        }
    }

    try {
        Invoke-GhCommand -Context $Context -Arguments @('api', "repos/$Owner/$Repo/branches/$TargetBranch/protection") | Out-Null
    }
    catch {
        $failures += "cannot access branch protection for ${TargetBranch}: $($_.Exception.Message)"
    }

    if (@($failures).Count -gt 0) {
        $body = @(
            '# Preflight Failure'
            ''
            "- Time (UTC): $((Get-Date).ToUniversalTime().ToString('s'))"
            "- Branch: $TargetBranch"
            "- Failures:"
        )
        foreach ($item in $failures) {
            $body += "  - $item"
        }

        Write-MarkdownReport -Context $Context -RelativePath 'logs/ci-fix/preflight-failure.md' -Content ($body -join "`n")
        throw "Preflight failed: $($failures -join '; ')"
    }
}

function New-MergeLock {
    param(
        [pscustomobject]$Context,
        [string]$MergeSha,
        [int]$TimeoutMinutes = 30,
        [string]$RunId = ''
    )

    $lockDir = Join-Path $Context.RepoRoot 'logs/ci-fix/active-jobs'
    New-Item -ItemType Directory -Path $lockDir -Force | Out-Null
    $lockPath = Join-Path $lockDir "$MergeSha.lock"

    if (Test-Path -LiteralPath $lockPath) {
        $existingRaw = Get-Content -Path $lockPath -Raw
        $existing = $null
        try {
            $existing = $existingRaw | ConvertFrom-Json
        }
        catch {
            $existing = $null
        }

        if ($existing -and $existing.timestampUtc) {
            $age = (Get-Date).ToUniversalTime() - ([datetime]$existing.timestampUtc)
            if ($age.TotalMinutes -le $TimeoutMinutes) {
                return [pscustomobject]@{
                    Acquired = $false
                    LockPath = $lockPath
                    Message  = 'already processing'
                }
            }
        }
    }

    $payload = [pscustomobject]@{
        mergeSha     = $MergeSha
        timestampUtc = (Get-Date).ToUniversalTime().ToString('o')
        runId        = $RunId
        actor        = $env:GITHUB_ACTOR
        machine      = $env:RUNNER_NAME
    }

    $payload | ConvertTo-Json | Set-Content -Path $lockPath
    return [pscustomobject]@{
        Acquired = $true
        LockPath = $lockPath
        Message  = 'lock acquired'
    }
}

function Remove-MergeLock {
    param([string]$LockPath)

    if ($LockPath -and (Test-Path -LiteralPath $LockPath)) {
        Remove-Item -Path $LockPath -Force
    }
}

function New-TemporaryFixBranch {
    param(
        [pscustomobject]$Context,
        [string]$TargetBranch = 'main',
        [string]$Prefix = 'auto-fix/merge'
    )

    $stamp = (Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss')
    $name = "$Prefix-$stamp"

    Invoke-GitCommand -Context $Context -Arguments @('checkout', $TargetBranch) | Out-Null
    Invoke-GitCommand -Context $Context -Arguments @('pull', '--ff-only', 'origin', $TargetBranch) | Out-Null
    Invoke-GitCommand -Context $Context -Arguments @('checkout', '-b', $name) | Out-Null
    return $name
}

function New-OrUpdatePullRequest {
    param(
        [pscustomobject]$Context,
        [string]$TargetBranch,
        [string]$HeadBranch,
        [string]$MergeSha,
        [string]$BodyPath
    )

    if ($Context.IsDryRun) {
        Write-CiFixLog -Context $Context -Level 'INFO' -Category 'dry_run' -Message "DRY_RUN: would create/update PR from $HeadBranch to $TargetBranch"
        return $null
    }

    $existing = Invoke-GhCommand -Context $Context -Arguments @('pr', 'list', '--base', $TargetBranch, '--head', $HeadBranch, '--json', 'number')
    $items = $existing | ConvertFrom-Json
    if (@($items).Count -gt 0) {
        return [int]$items[0].number
    }

    $title = "auto-fix: post-merge CI for $MergeSha"
    $result = Invoke-GhCommand -Context $Context -Arguments @('pr', 'create', '--base', $TargetBranch, '--head', $HeadBranch, '--title', $title, '--body-file', $BodyPath)
    $match = [regex]::Match($result, '/pull/(\d+)')
    if (-not $match.Success) {
        throw 'Unable to parse PR number from gh pr create output.'
    }

    return [int]$match.Groups[1].Value
}

function Enable-PullRequestAutoMerge {
    param(
        [pscustomobject]$Context,
        [int]$PullRequestNumber,
        [string]$MergeMethod = 'squash'
    )

    if ($Context.IsDryRun -or $PullRequestNumber -le 0) {
        return
    }

    $methodFlag = "--$MergeMethod"
    Invoke-GhCommand -Context $Context -Arguments @('pr', 'merge', "$PullRequestNumber", '--auto', $methodFlag) | Out-Null
}

function Close-PullRequestWithComment {
    param(
        [pscustomobject]$Context,
        [int]$PullRequestNumber,
        [string]$Comment
    )

    if ($Context.IsDryRun -or $PullRequestNumber -le 0) {
        return
    }

    Invoke-GhCommand -Context $Context -Arguments @('pr', 'close', "$PullRequestNumber", '--comment', $Comment) | Out-Null
}
