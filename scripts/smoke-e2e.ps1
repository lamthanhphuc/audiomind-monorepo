param(
    [string]$AudioFile = "D:\Bin\EXE101\Thu_muc_moi\smoke-short-12s.wav",
    [string]$AiBaseUrl = "http://localhost:8000",
    [string]$ProcessingBaseUrl = "http://localhost:8082",
    [int]$PollIntervalSeconds = 2,
    [int]$TimeoutSeconds = 120,
    [int]$RetryThreshold = 3
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[SMOKE] $Message"
}

function Find-ContainerName {
    param([string[]]$Candidates)

    $all = docker ps --format "{{.Names}}"
    foreach ($name in $Candidates) {
        if ($all -contains $name) {
            return $name
        }
    }

    foreach ($line in $all) {
        foreach ($name in $Candidates) {
            if ($line -like "*$name*") {
                return $line
            }
        }
    }

    return $null
}

function Invoke-Json {
    param(
        [string]$Method,
        [string]$Url,
        [hashtable]$Headers,
        [string]$Body
    )

    $args = @("-sS", "-X", $Method, $Url)
    foreach ($k in $Headers.Keys) {
        $args += @("-H", "${k}: $($Headers[$k])")
    }
    if ($Body) {
        $args += @("-d", $Body)
    }

    $raw = & curl.exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "curl failed for $Method $Url"
    }
    return ($raw | ConvertFrom-Json)
}

function Invoke-Api {
    param(
        [string]$Method,
        [string]$Url,
        [hashtable]$Headers,
        [object]$Body,
        [string]$ContentType = "application/json"
    )

    if ($Method -eq "GET") {
        return Invoke-RestMethod -Method Get -Uri $Url -Headers $Headers
    }

    if ($null -eq $Body) {
        return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers
    }

    if ($Body -is [string]) {
        return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers -ContentType $ContentType -Body $Body
    }

    $jsonBody = $Body | ConvertTo-Json -Depth 8
    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers -ContentType $ContentType -Body $jsonBody
}

$report = [ordered]@{
    Result = "FAIL"
    Flow = [ordered]@{
        Upload = "FAIL"
        Process = "FAIL"
        Status = "FAIL"
        Result = "FAIL"
    }
    Issues = New-Object System.Collections.Generic.List[string]
    RootCause = New-Object System.Collections.Generic.List[string]
    Fixes = New-Object System.Collections.Generic.List[string]
}

$statusEndpointUsed = "processing"
$transcriptEndpointUsed = "processing"

$required = @{
    ai = @("infra-ai-api-1", "ai-api", "ai-service-gpu")
    redis = @("infra-redis-1", "redis", "ai-redis")
    worker = @("infra-celery-worker", "ai-service-worker", "worker", "celery-worker")
    processing = @("infra-processing-api-1", "processing-api", "processing-service")
}

$resolved = @{}
foreach ($key in $required.Keys) {
    $found = Find-ContainerName -Candidates $required[$key]
    $resolved[$key] = $found
}

$missing = @()
foreach ($key in $resolved.Keys) {
    if ([string]::IsNullOrWhiteSpace($resolved[$key])) {
        $missing += $key
    }
}

if ($missing.Count -gt 0) {
    $report.Issues.Add("Missing required containers: $($missing -join ', ')")
    throw "Missing required services: $($missing -join ', ')"
}

Write-Step "Required containers found: ai=$($resolved.ai), redis=$($resolved.redis), worker=$($resolved.worker), processing=$($resolved.processing)"

try {
    $null = Invoke-Api -Method "GET" -Url "$AiBaseUrl/health" -Headers @{} -Body $null

    $null = Invoke-Api -Method "GET" -Url "$ProcessingBaseUrl/health" -Headers @{} -Body $null

    $null = Invoke-Api -Method "GET" -Url "$ProcessingBaseUrl/actuator/health" -Headers @{} -Body $null

    if (-not (Test-Path -LiteralPath $AudioFile)) {
        throw "Audio file not found: $AudioFile"
    }

    Write-Step "Step 1 Upload file: $AudioFile"
    $uploadRaw = & curl.exe -sS -F "file=@$AudioFile" "$ProcessingBaseUrl/processing/upload"
    if ($LASTEXITCODE -ne 0) {
        throw "Upload request failed"
    }
    $upload = $uploadRaw | ConvertFrom-Json
    if (-not $upload.audio_path) {
        throw "Upload response missing audio_path"
    }
    $report.Flow.Upload = "OK"

    $meetingId = [int](Get-Date -UFormat %s)
    $fileId = [string]$upload.audio_path
    $processBody = @{
        meeting_id = $meetingId
        audio_path = [string]$upload.audio_path
        file_id = $fileId
        topic = "smoke-test"
        language = "vi"
    }

    Write-Step "Step 2 Start processing with meeting_id=$meetingId"
    $process = Invoke-Api -Method "POST" -Url "$ProcessingBaseUrl/processing/start" -Headers @{} -Body $processBody
    $processMeetingId = $null
    if ($process.PSObject.Properties.Name -contains "meeting_id") {
        $processMeetingId = [int]$process.meeting_id
    } elseif ($process.PSObject.Properties.Name -contains "meetingId") {
        $processMeetingId = [int]$process.meetingId
    }
    if ($null -eq $processMeetingId) {
        throw "Process response missing meeting_id"
    }
    $meetingId = $processMeetingId
    $report.Flow.Process = "OK"

    Write-Step "Step 3 Poll status"
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $timeline = New-Object System.Collections.Generic.List[string]
    $finalStatus = ""
    $statusPollStart = Get-Date
    $maxAllowedSeconds = $TimeoutSeconds

    while ((Get-Date) -lt $deadline) {
        $statusObj = Invoke-Api -Method "GET" -Url "$ProcessingBaseUrl/processing/status/$meetingId" -Headers @{} -Body $null
        $aiStatusObj = Invoke-Api -Method "GET" -Url "$AiBaseUrl/api/meeting/$meetingId/status" -Headers @{} -Body $null
        if ([string]$statusObj.status -eq "NOT_FOUND") {
            throw "Invalid architecture: processing must own status"
        }

        $status = [string]$statusObj.status
        $procStage = [string]$statusObj.stage
        $aiStage = [string]$aiStatusObj.stage
        $procProgress = 0
        $aiProgress = 0
        if ($statusObj.PSObject.Properties.Name -contains "progress") {
            $procProgress = [int]$statusObj.progress
        }
        if ($aiStatusObj.PSObject.Properties.Name -contains "progress") {
            $aiProgress = [int]$aiStatusObj.progress
        }

        if ([string]$aiStatusObj.status -ne $status) {
            throw "Status mismatch processing=$status ai=$($aiStatusObj.status)"
        }
        if ($procStage -ne $aiStage) {
            throw "Stage mismatch processing=$procStage ai=$aiStage"
        }
        if ([Math]::Abs($procProgress - $aiProgress) -gt 5) {
            throw "Progress mismatch processing=$procProgress ai=$aiProgress"
        }

        $retryCount = 0
        if ($statusObj.PSObject.Properties.Name -contains "retry_count") {
            $retryCount = [int]$statusObj.retry_count
        }

        $timeline.Add($status)
        Write-Step "Status=$status stage=$procStage progress=$procProgress retry_count=$retryCount"

        if ($retryCount -gt $RetryThreshold) {
            $report.Issues.Add("Retry exceeded threshold: retry_count=$retryCount")
            throw "retry_count > $RetryThreshold"
        }

        $elapsedSeconds = ((Get-Date) - $statusPollStart).TotalSeconds
        if ($elapsedSeconds -gt $maxAllowedSeconds -and $status -ne "COMPLETED" -and $status -ne "FAILED") {
            $report.Issues.Add("Job exceeded 60s without completion. status=$status")
            throw "job > $maxAllowedSeconds s not terminal"
        }

        if ($status -eq "COMPLETED") {
            $finalStatus = $status
            break
        }
        if ($status -eq "FAILED") {
            $finalStatus = $status
            break
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }

    if ([string]::IsNullOrWhiteSpace($finalStatus)) {
        $report.Issues.Add("Polling timeout after $TimeoutSeconds seconds")
        throw "Timeout waiting for completion"
    }

    $report.Flow.Status = "OK"

    if ($finalStatus -eq "FAILED") {
        $report.Result = "PASS"
        $report.Flow.Result = "SKIPPED"
        Write-Step "Terminal FAILED accepted by policy; skip transcript fetch"
        return
    }

    Write-Step "Step 4 Fetch transcript"
    $transcriptObj = $null
    $transcriptDeadline = (Get-Date).AddSeconds(30)
    while ((Get-Date) -lt $transcriptDeadline) {
        try {
            $transcriptObj = Invoke-Api -Method "GET" -Url "$ProcessingBaseUrl/processing/transcript/$meetingId" -Headers @{} -Body $null
            break
        }
        catch {
            if ($_.Exception.Message -notmatch "404") {
                throw
            }
        }

        Start-Sleep -Seconds $PollIntervalSeconds
    }

    if ($null -eq $transcriptObj) {
        throw "Transcript not ready before deadline"
    }

    $hasTranscript = $false
    if ($transcriptObj.PSObject.Properties.Name -contains "data") {
        if ($transcriptObj.data -and $transcriptObj.data.transcripts) {
            if (@($transcriptObj.data.transcripts).Count -gt 0) {
                $hasTranscript = $true
            }
        }
    }
    if (($transcriptObj.PSObject.Properties.Name -contains "transcripts") -and -not $hasTranscript) {
        if (@($transcriptObj.transcripts).Count -gt 0) {
            $hasTranscript = $true
        }
    }

    if (-not $hasTranscript) {
        $report.Issues.Add("Transcript payload missing or empty")
        throw "Transcript not available"
    }

    $report.Flow.Result = "OK"
    $report.Result = "PASS"
}
catch {
    $err = $_.Exception.Message
    $report.Issues.Add("Smoke flow failed: $err")

    Write-Step "Auto debug: collect logs and runtime evidence"

    $workerLogs = (& docker logs --tail 200 $resolved.worker 2>&1) | Out-String
    $aiLogs = (& docker logs --tail 200 $resolved.ai 2>&1) | Out-String
    $processingLogs = (& docker logs --tail 200 $resolved.processing 2>&1) | Out-String

    $redisKeys = (& docker exec $resolved.redis redis-cli --raw KEYS *job* 2>&1) | Out-String
    $firstKey = ($redisKeys -split "`r?`n" | Where-Object { $_ -and $_ -notmatch "^\(error\)" } | Select-Object -First 1)
    $ttlValue = "N/A"
    if ($firstKey) {
        $ttlValue = ((& docker exec $resolved.redis redis-cli --raw TTL $firstKey 2>&1) | Out-String).Trim()
    }

    if ($workerLogs -notmatch "received|task|celery") {
        $report.RootCause.Add("Celery worker did not show task intake evidence")
        $report.Fixes.Add("Check broker wiring and worker command in demoRecordAUDIOMID/ai-service/docker-compose.yml; ensure CELERY_BROKER_URL points to redis and worker starts with celery -A app.celery_app.celery_app worker")
    }

    if ($workerLogs -match "FileNotFoundError: Audio file not found") {
        $report.RootCause.Add("Celery worker cannot access uploaded audio file path")
        $report.Fixes.Add("Mount same uploads volume for ai-api and celery-worker (e.g., volume mapping to /app/uploads in both containers)")
    }

    if ($workerLogs -match "password authentication failed|psycopg2\.OperationalError|sqlalchemy\.exc\.OperationalError") {
        $report.RootCause.Add("Celery worker database authentication is misconfigured")
        $report.Fixes.Add("Set DATABASE_URL for celery-worker consistent with ai-api and Postgres credentials, then restart worker")
    }

    if ($workerLogs -match "time limit|SoftTimeLimitExceeded|hard time limit|WorkerLostError") {
        $report.RootCause.Add("Worker timeout/termination suggests stuck RUNNING scenario")
        $report.Fixes.Add("Add/adjust CELERY_TASK_TIME_LIMIT and soft time limit in demoRecordAUDIOMID/ai-service/app/celery_app.py and task handlers in demoRecordAUDIOMID/ai-service/app/tasks.py")
    }

    if ($report.Issues -join " " -match "Invalid architecture") {
        $report.RootCause.Add("processing-service returned NOT_FOUND for an active orchestration job")
        $report.Fixes.Add("Make processing-service source of truth for job state and ai job mapping before exposing status API")
    }

    if (($report.Issues -join " ") -match "Polling timeout" -and ($workerLogs -match "ERROR|Exception|Traceback")) {
        $report.RootCause.Add("Background task errors prevented state transition from QUEUED")
        $report.Fixes.Add("Propagate task exceptions to job status as FAILED and ensure worker logs are monitored in health checks")
    }

    if ($ttlValue -eq "-1") {
        $report.RootCause.Add("Redis job key has no TTL")
        $report.Fixes.Add("Set Redis expiry for job status keys, e.g., redis.set(key, value, ex=3600)")
    }

    if (($processingLogs -match "timed out|timeout|Read timed out") -or ($processingLogs -match "Connection refused|5\d\d")) {
        $report.RootCause.Add("Inter-service API instability/timeout in processing service")
        $report.Fixes.Add("Add retry/backoff on AI calls in processing service using @Retryable(maxAttempts=3, backoff=@Backoff(delay=1000))")
    }

    if ($aiLogs -match "Traceback|ERROR|Exception") {
        $report.RootCause.Add("AI service runtime errors detected in logs")
    }

    $debugDir = "logs"
    if (-not (Test-Path -LiteralPath $debugDir)) {
        New-Item -ItemType Directory -Path $debugDir | Out-Null
    }
    $workerLogs | Set-Content -LiteralPath "$debugDir/smoke-worker.log"
    $aiLogs | Set-Content -LiteralPath "$debugDir/smoke-ai.log"
    $processingLogs | Set-Content -LiteralPath "$debugDir/smoke-processing.log"
    $redisKeys | Set-Content -LiteralPath "$debugDir/smoke-redis-keys.log"
}

$reportPath = "logs/smoke-test-report.md"
$lines = New-Object System.Collections.Generic.List[string]
$lines.Add("# Smoke Test Report")
$lines.Add("")
$lines.Add("## Result")
$lines.Add($report.Result)
$lines.Add("")
$lines.Add("## Flow log")
$lines.Add("- Upload: $($report.Flow.Upload)")
$lines.Add("- Process: $($report.Flow.Process)")
$lines.Add("- Status: $($report.Flow.Status)")
$lines.Add("- Result: $($report.Flow.Result)")
$lines.Add("- Status endpoint used: $statusEndpointUsed")
$lines.Add("- Transcript endpoint used: $transcriptEndpointUsed")
$lines.Add("")
$lines.Add("## Issues found")
if ($report.Issues.Count -eq 0) {
    $lines.Add("- none")
} else {
    foreach ($i in $report.Issues) { $lines.Add("- $i") }
}
$lines.Add("")
$lines.Add("## Root cause")
if ($report.RootCause.Count -eq 0) {
    $lines.Add("- none")
} else {
    foreach ($r in $report.RootCause) { $lines.Add("- $r") }
}
$lines.Add("")
$lines.Add("## Fix đề xuất")
if ($report.Fixes.Count -eq 0) {
    $lines.Add("- none")
} else {
    foreach ($f in $report.Fixes) { $lines.Add("- $f") }
}

if (-not (Test-Path -LiteralPath "logs")) {
    New-Item -ItemType Directory -Path "logs" | Out-Null
}
$lines | Set-Content -LiteralPath $reportPath

Write-Host "\n[SMOKE] Report written to $reportPath"
Get-Content -LiteralPath $reportPath

if ($report.Result -eq "PASS") {
    Write-Host "\n[SMOKE] System ready for next step."
    exit 0
}

exit 1
