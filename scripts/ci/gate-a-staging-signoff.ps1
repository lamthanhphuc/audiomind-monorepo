param(
    [string]$ComposeEnvFile = "infra/.env",
    [switch]$SkipComposeUp
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
Push-Location $repoRoot

try {
    if (-not (Test-Path $ComposeEnvFile)) {
        Copy-Item "infra/.env.example" $ComposeEnvFile
    }

    if (-not $SkipComposeUp) {
        Write-Host "[GATE-A-STAGING] Starting staging overlay stack..."
        docker compose --env-file $ComposeEnvFile `
            -f infra/docker-compose.dev.yml `
            -f infra/docker-compose.mvp.yml `
            -f infra/docker-compose.staging.yml up -d --build db redis user-api ai-api celery-worker meeting-api processing-api web
    }

    Write-Host "[GATE-A-STAGING] Run automated Gate-A verification..."
    powershell -ExecutionPolicy Bypass -File scripts/ci/gate-a-verify.ps1
    if ($LASTEXITCODE -ne 0) {
        throw "gate-a-verify.ps1 failed"
    }

    if ($env:E2E_USERNAME -and $env:E2E_PASSWORD) {
        Write-Host "[GATE-A-STAGING] Running smoke + Epic3 matrix..."
        ./scripts/setup-e2e-account.ps1
        ./scripts/smoke-e2e.ps1 -Epic3Matrix `
            -E2EUsername $env:E2E_USERNAME -E2EPassword $env:E2E_PASSWORD
    } else {
        Write-Host "[GATE-A-STAGING] Skipping smoke (set E2E_USERNAME/E2E_PASSWORD for full matrix)"
    }

    Write-Host ""
    Write-Host "=== Manual QA still required on staging ==="
    Write-Host "- F9 realtime: no-speech, mic sensitivity, noise suppression, Deepgram fallback"
    Write-Host "- F9 re-analyze v2 preservation (UI + logs)"
    Write-Host "- ErrorUX mic denied / invalid capture (browser permissions)"
    Write-Host "Record outcomes in docs/specs/gate-a-pre-beta-acceptance-checklist.md"
}
finally {
    Pop-Location
}
