# E2E orchestrator: start services, health checks, create meeting, start WS listener, upload audio, start processing
Set-StrictMode -Version Latest

$repoRoot = Split-Path $PSScriptRoot -Parent
$dockerExe = 'C:\Program Files\Docker\Docker\resources\bin\docker.exe'
$hybridMode = $env:HYBRID_MODE -eq '1'
$meetingBaseUrl = if ($env:MEETING_BASE_URL) { $env:MEETING_BASE_URL.TrimEnd('/') } else { 'http://localhost:8081' }
$processingBaseUrl = if ($env:PROCESSING_BASE_URL) { $env:PROCESSING_BASE_URL.TrimEnd('/') } else { 'http://localhost:8082' }
$userBaseUrl = if ($env:USER_BASE_URL) { $env:USER_BASE_URL.TrimEnd('/') } else { 'http://localhost:8083' }
$wsBaseUrl = if ($env:WS_BASE_URL) { $env:WS_BASE_URL.TrimEnd('/') } else { 'ws://localhost:8082' }

Set-Location $repoRoot

Write-Host "Working directory: $(Get-Location)"

function Invoke-CurlJson {
    param(
        [string]$Method,
        [string]$Url,
        [hashtable]$Headers,
        [string]$Body
    )

    $args = @('-sS', '-X', $Method)
    foreach ($key in $Headers.Keys) {
        $args += @('-H', ("{0}: {1}" -f $key, $Headers[$key]))
    }
    if ($Body) {
        $args += @('-H', 'Content-Type: application/json', '--data-raw', $Body)
    }
    $args += $Url

    $raw = & curl.exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "curl failed for $Method $Url"
    }

    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    return $raw | ConvertFrom-Json
}

function Invoke-CurlMultipart {
    param(
        [string]$Url,
        [hashtable]$Headers,
        [hashtable]$Fields
    )

    $args = @('-sS', '-X', 'POST')
    foreach ($key in $Headers.Keys) {
        $args += @('-H', ("{0}: {1}" -f $key, $Headers[$key]))
    }
    foreach ($key in $Fields.Keys) {
        $value = $Fields[$key]
        if ($value -is [System.IO.FileInfo]) {
            $args += @('-F', ("{0}=@{1}" -f $key, $value.FullName))
        } else {
            $args += @('-F', ("{0}={1}" -f $key, $value))
        }
    }
    $args += $Url

    $raw = & curl.exe @args
    if ($LASTEXITCODE -ne 0) {
        throw "curl failed for POST $Url"
    }

    if ([string]::IsNullOrWhiteSpace($raw)) {
        return $null
    }

    return $raw | ConvertFrom-Json
}

if (-not $hybridMode) {
    Write-Host "Starting docker compose (detached)..."
    & $dockerExe compose --env-file infra/.env -f infra/docker-compose.dev.yml up -d
} else {
    Write-Host "Hybrid mode enabled; skipping docker compose startup."
}

Write-Host "Waiting 30 seconds for services..."
Start-Sleep -Seconds 30

Write-Host "Checking health endpoints..."
try {
    $procHealth = Invoke-RestMethod -Uri "$processingBaseUrl/actuator/health" -Method GET -ErrorAction Stop
    Write-Host "processing-service health: $($procHealth.status)"
} catch {
    Write-Host "processing-service health check failed: $_"
}
try {
    $aiHealth = Invoke-RestMethod -Uri "http://localhost:8000/health" -Method GET -ErrorAction Stop
    Write-Host "ai-service health: $aiHealth"
} catch {
    Write-Host "ai-service health check failed: $_"
}

# Login
Write-Host "Logging in to Auth service..."
$loginBody = '{"username":"e2e_test_user","password":"Ph@050204"}'
try {
    $loginResponse = Invoke-RestMethod -Uri "$userBaseUrl/api/users/login" -Method POST -Body $loginBody -ContentType "application/json" -ErrorAction Stop
    $token = if ($loginResponse.accessToken) { $loginResponse.accessToken } else { $loginResponse.token }
    Write-Host "TOKEN: $token"
} catch {
    Write-Host "Login failed: $_"
    exit 1
}

# Create meeting
Write-Host "Creating test meeting..."
$meeting = Invoke-RestMethod -Uri "$meetingBaseUrl/api/v1/meetings" -Method POST -Headers @{Authorization="Bearer $token"} -ContentType "application/json"
Write-Host "MEETING_ID: $($meeting.id)"

# Ensure test WAV exists
if (!(Test-Path "test-audio.wav")) {
    Write-Host "Generating test-audio.wav (5s)..."
    python (Join-Path $repoRoot 'scripts/generate_test_wav.py') (Join-Path $repoRoot 'test-audio.wav') 5
} else {
    Write-Host "test-audio.wav already exists"
}

# Ensure websockets lib
Write-Host "Installing websockets (user)..."
& 'C:\Users\ADMIN\AppData\Local\Programs\Python\Python310\python.exe' -m pip install --user websockets | Out-Null

Start-Sleep -Seconds 2

## Monitor health during upload to validate async behavior
$healthLog = Join-Path $repoRoot 'tmp-upload-health.log'
Remove-Item -ErrorAction SilentlyContinue $healthLog
$healthJob = Start-Job -ScriptBlock {
    param($baseUrl, $logPath)
    while ($true) {
        try {
            $status = (Invoke-RestMethod -Uri "$baseUrl/actuator/health" -Method GET -ErrorAction Stop).status
            Add-Content -Path $logPath -Value ("$(Get-Date -Format o) HEALTH $status")
        } catch {
            Add-Content -Path $logPath -Value ("$(Get-Date -Format o) HEALTH ERROR $($_.Exception.Message)")
        }
        Start-Sleep -Seconds 2
    }
} -ArgumentList $processingBaseUrl, $healthLog

# Upload file through processing-service
Write-Host "Uploading test-audio.wav..."
try {
    $uploadResponse = Invoke-CurlMultipart -Url "$processingBaseUrl/processing/upload" -Headers @{Authorization="Bearer $token"} -Fields @{file=Get-Item (Join-Path $repoRoot 'test-audio.wav')}
    Write-Host "UPLOAD_RESPONSE: $uploadResponse"
} catch {
    Write-Host "Upload failed: $_"
}

Stop-Job $healthJob | Out-Null
$healthOutput = Receive-Job $healthJob -ErrorAction SilentlyContinue
Remove-Job $healthJob -Force -ErrorAction SilentlyContinue
Write-Host "Upload health samples captured: $((Get-Content $healthLog -ErrorAction SilentlyContinue | Measure-Object).Count)"

Write-Host "Creating numeric meeting record for processing..."
try {
    $meetingUpload = Invoke-CurlMultipart -Url "$meetingBaseUrl/meetings/upload" -Headers @{Authorization="Bearer $token"} -Fields @{title='Hybrid Test Meeting'; file=Get-Item (Join-Path $repoRoot 'test-audio.wav')}
    Write-Host "MEETING_UPLOAD_RESPONSE: $meetingUpload"
} catch {
    Write-Host "Meeting upload failed: $_"
    exit 1
}

$processingMeetingId = [int]$meetingUpload.id
$processingAudioPath = [string]$meetingUpload.audioPath
Write-Host "PROCESSING_MEETING_ID: $processingMeetingId"

# Start WS listener in background and capture output
Write-Host "Starting WS listener in background..."
$wsLog = Join-Path $repoRoot 'tmp-ws-listener.log'
$wsErrLog = Join-Path $repoRoot 'tmp-ws-listener.err.log'
Remove-Item -ErrorAction SilentlyContinue $wsLog
Remove-Item -ErrorAction SilentlyContinue $wsErrLog
$listenerScript = Join-Path $repoRoot 'scripts/ws_listener.py'
$wsProcess = Start-Process -FilePath 'C:\Users\ADMIN\AppData\Local\Programs\Python\Python310\python.exe' `
    -ArgumentList @('-u', [string]$listenerScript, [string]$processingMeetingId, [string]$token, [string]$wsBaseUrl) `
    -NoNewWindow -PassThru -RedirectStandardOutput $wsLog -RedirectStandardError $wsErrLog

# Start processing
Write-Host "Starting processing..."
$processBody = @{
    meeting_id = $processingMeetingId
    audio_path = $processingAudioPath
    file_id = $processingAudioPath
    topic = "Realtime Test Meeting"
    language = "vi"
}
try {
    # Use the body-based start endpoint so the uploaded audio path is sent directly.
    try {
        $startBody = @{
            meeting_id = $processingMeetingId
            audio_path = $processingAudioPath
            file_id = $processingAudioPath
            topic = "Realtime Test Meeting"
            language = "vi"
        } | ConvertTo-Json -Depth 4
        $startResp = Invoke-CurlJson -Method POST -Url "$processingBaseUrl/processing/start" -Headers @{ Authorization = "Bearer $token" } -Body $startBody
        Write-Host "PROCESSING START RESPONSE: $($startResp | ConvertTo-Json -Compress)"
    } catch {
        Write-Host "Processing start failed: $_"
        $startResp = $null
    }
} catch {
    Write-Host "Processing start failed: $_"
}

# Attempt to extract jobId
$jobId = [string]$processingMeetingId
if ($startResp -ne $null) {
    foreach ($candidate in @('jobId', 'meetingId', 'meeting_id', 'id')) {
        if ($startResp.PSObject.Properties.Name -contains $candidate) {
            $jobId = [string]$startResp.$candidate
            break
        }
    }
}
Write-Host "JOB_ID: $jobId"

if ($jobId) {
    Write-Host "Polling job status..."
    $deadline = (Get-Date).AddSeconds(180)
    while ((Get-Date) -lt $deadline) {
        try {
            $status = Invoke-RestMethod -Uri "$processingBaseUrl/processing/status/$jobId" -Headers @{Authorization="Bearer $token"} -ErrorAction Stop
            $state = if ($status.PSObject.Properties.Name -contains 'state') { [string]$status.state } elseif ($status.PSObject.Properties.Name -contains 'status') { [string]$status.status } else { 'unknown' }
            Write-Host "JOB STATUS: $state"
            if ($state -in @('COMPLETED', 'FAILED', 'CANCELLED', 'ERROR')) {
                break
            }
        } catch {
            Write-Host "Job status check failed: $_"
            break
        }

        Start-Sleep -Seconds 2
    }
} else {
    Write-Host "No job id returned from processing start. You can monitor WebSocket output for events."
}

Start-Sleep -Seconds 3

if ((Test-Path $wsLog) -or (Test-Path $wsErrLog)) {
    $wsContent = @()
    if (Test-Path $wsLog) {
        $wsContent += Get-Content $wsLog -ErrorAction SilentlyContinue
    }
    if (Test-Path $wsErrLog) {
        $wsContent += Get-Content $wsErrLog -ErrorAction SilentlyContinue
    }
    $partialCount = @($wsContent | Select-String -Pattern 'EVENT: transcript\.partial').Count
    $keywordCount = @($wsContent | Select-String -Pattern 'EVENT: keyword\.hit').Count
    Write-Host "WS transcript.partial events: $partialCount"
    Write-Host "WS keyword.hit events: $keywordCount"
    Write-Host "WS raw log: $wsLog"
    Write-Host "WS error log: $wsErrLog"
}

if (Get-Job $healthJob -ErrorAction SilentlyContinue) {
    Stop-Job $healthJob -ErrorAction SilentlyContinue | Out-Null
    Remove-Job $healthJob -Force -ErrorAction SilentlyContinue
}

if ($wsProcess -and -not $wsProcess.HasExited) {
    Stop-Process -Id $wsProcess.Id -ErrorAction SilentlyContinue
}

if ($jobId) {
    try {
        $transcript = Invoke-RestMethod -Uri "$processingBaseUrl/processing/transcript/$jobId" -Headers @{Authorization="Bearer $token"} -ErrorAction Stop
        Write-Host "TRANSCRIPT_RESPONSE: $($transcript | ConvertTo-Json -Compress -Depth 6)"
    } catch {
        Write-Host "Transcript fetch failed: $_"
    }
}

Write-Host "E2E orchestrator finished. Check console output above and WS listener process for realtime events."