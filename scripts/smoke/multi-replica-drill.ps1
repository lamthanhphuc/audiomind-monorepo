param(
    [string]$ComposeEnvFile = "infra/.env",
    [int]$ProcessingReplicas = 2,
    [int]$AiReplicas = 2
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repoRoot

try {
    if (-not (Test-Path $ComposeEnvFile)) {
        Copy-Item infra/.env.staging.example $ComposeEnvFile
    }

    Write-Host "[MULTI-REPLICA] Starting stack with REALTIME_REDIS_STREAMS + GEMINI_SHARED_COOLDOWN..."
    $env:REALTIME_REDIS_STREAMS_ENABLED = "true"
    $env:GEMINI_SHARED_COOLDOWN_ENABLED = "true"

    docker compose --env-file $ComposeEnvFile `
        -f infra/docker-compose.dev.yml `
        -f infra/docker-compose.mvp.yml `
        -f infra/docker-compose.staging.yml `
        -f infra/docker-compose.staging-scale.yml `
        up -d --build --scale processing-api=$ProcessingReplicas --scale ai-api=$AiReplicas

    $deadline = (Get-Date).AddMinutes(5)
    while ((Get-Date) -lt $deadline) {
        try {
            Invoke-RestMethod -Uri "http://localhost:8082/ready" -TimeoutSec 5 | Out-Null
            Invoke-RestMethod -Uri "http://localhost:8000/ready" -TimeoutSec 5 | Out-Null
            break
        } catch {
            Start-Sleep -Seconds 5
        }
    }

    $processingCount = (docker compose --env-file $ComposeEnvFile `
        -f infra/docker-compose.dev.yml `
        -f infra/docker-compose.mvp.yml `
        -f infra/docker-compose.staging.yml `
        -f infra/docker-compose.staging-scale.yml ps -q processing-api | Measure-Object).Count

    if ($processingCount -lt $ProcessingReplicas) {
        throw "Expected $ProcessingReplicas processing-api containers, found $processingCount"
    }

    Write-Host "[MULTI-REPLICA] Running RealtimeEventSubscriberRedisIT..."
    Push-Location demoRecordAUDIOMID/processing-service
    ..\mvnw.cmd "-Dtest=RealtimeEventSubscriberRedisIT" test -q
    Pop-Location

    Write-Host "[MULTI-REPLICA] ALL PASSED ($processingCount processing-api replicas)"
}
finally {
    Pop-Location
}
