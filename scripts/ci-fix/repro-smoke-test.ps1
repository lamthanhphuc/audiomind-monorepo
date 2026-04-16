param(
    [string]$ComposeFile = 'infra/docker-compose.dev.yml',
    [string]$AudioInput = 'tests/audio/it-overview.mp3',
    [string]$AudioOutput = 'tests/audio/it-overview.wav',
    [string[]]$Services = @('db', 'redis', 'user-api', 'ai-api', 'celery-worker', 'meeting-api', 'processing-api'),
    [string]$AiBaseUrl = 'http://localhost:8000',
    [string]$ProcessingBaseUrl = 'http://localhost:8082',
    [string]$UserServiceBaseUrl = 'http://localhost:8083',
    [string]$E2EUsername = 'e2e_test_user',
    [string]$E2EPassword = 'Test@123456',
    [int]$PollIntervalSeconds = 2,
    [int]$TimeoutSeconds = 300,
    [switch]$KeepStack,
    [string]$LogDir = 'logs/ci-fix'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[ci-fix:smoke] $Message"
}

function Assert-CommandExists {
    param([string]$Command)
    $cmd = Get-Command $Command -ErrorAction SilentlyContinue
    if ($null -eq $cmd) {
        throw "Required command not found: $Command"
    }
}

$resolvedLogDir = Join-Path (Get-Location) $LogDir
New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logPath = Join-Path $resolvedLogDir "repro-smoke-test-$stamp.log"
$composeLogsPath = Join-Path $resolvedLogDir "repro-smoke-docker-$stamp.log"

Start-Transcript -Path $logPath -Force | Out-Null

try {
    Assert-CommandExists -Command 'docker'
    Assert-CommandExists -Command 'ffmpeg'

    if (-not (Test-Path -LiteralPath $ComposeFile)) {
        throw "Compose file not found: $ComposeFile"
    }

    if (-not (Test-Path -LiteralPath $AudioInput)) {
        throw "Input MP3 not found: $AudioInput"
    }

    $serviceList = ($Services -join ' ')

    Write-Step "Starting stack with services: $serviceList"
    docker compose -f $ComposeFile up -d --build @Services
    if ($LASTEXITCODE -ne 0) {
        throw 'docker compose up failed'
    }

    Write-Step "Converting audio: $AudioInput -> $AudioOutput"
    ffmpeg -y -i $AudioInput $AudioOutput
    if ($LASTEXITCODE -ne 0) {
        throw 'ffmpeg conversion failed'
    }

    Write-Step 'Running smoke script'
    ./scripts/setup-e2e-account.ps1
    ./scripts/smoke-e2e.ps1 -AudioFile $AudioOutput -AiBaseUrl $AiBaseUrl -ProcessingBaseUrl $ProcessingBaseUrl -UserServiceBaseUrl $UserServiceBaseUrl -E2EUsername $E2EUsername -E2EPassword $E2EPassword -PollIntervalSeconds $PollIntervalSeconds -TimeoutSeconds $TimeoutSeconds
    if ($LASTEXITCODE -ne 0) {
        throw 'scripts/smoke-e2e.ps1 returned non-zero exit code'
    }

    Write-Step "SUCCESS: smoke-test local repro passed. Log: $logPath"
}
catch {
    Write-Step "FAIL: $($_.Exception.Message)"
    Write-Step 'Collecting docker compose logs for diagnostics'
    docker compose -f $ComposeFile logs | Set-Content -Path $composeLogsPath
    throw
}
finally {
    if (-not $KeepStack) {
        Write-Step 'Teardown stack (down -v)'
        docker compose -f $ComposeFile down -v
    }
    Stop-Transcript | Out-Null
}