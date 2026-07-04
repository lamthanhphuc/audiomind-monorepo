# Gate-A automated verification (F9/F10/ErrorUX/Validation test suites).
# Run from repo root:
#   powershell -ExecutionPolicy Bypass -File scripts/ci/gate-a-verify.ps1

$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$failures = @()

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )
    Write-Host "`n=== $Name ===" -ForegroundColor Cyan
    try {
        & $Action
        if ($LASTEXITCODE -and $LASTEXITCODE -ne 0) {
            throw "Exit code $LASTEXITCODE"
        }
        Write-Host "PASS: $Name" -ForegroundColor Green
    } catch {
        Write-Host "FAIL: $Name - $($_.Exception.Message)" -ForegroundColor Red
        $script:failures += $Name
    }
}

Invoke-Step 'FE Gate-A unit tests' {
    Push-Location (Join-Path $repoRoot 'FE-Audiomind')
    npm test -- --run `
        src/constants/errorCatalog.test.ts `
        src/services/api.test.ts `
        src/services/billing.test.ts `
        src/services/googleIntegration.test.ts `
        src/services/configService.test.ts `
        src/components/features/BillingScene.test.tsx `
        src/components/features/RealtimeDashboardScene.test.tsx `
        src/components/features/MeetingHistoryScene.test.tsx `
        src/components/features/GoogleIntegrationScene.test.tsx `
        src/app/App.billing-success.test.tsx `
        src/components/dashboard/DashboardLayout.test.tsx `
        src/components/dashboard/GlobalMeetingSearch.test.tsx `
        src/components/features/GlossaryNotesPanel.test.tsx `
        src/components/dashboard/AiAssistant.test.tsx `
        src/components/analysis/AnalysisStatusPanel.test.tsx `
        src/components/transcript/TranscriptDisplay.test.tsx `
        src/hooks/useRealtimeMeetingStream.test.tsx `
        src/components/realtime/AudioRecorderButton.test.tsx
    Pop-Location
}

Invoke-Step 'Processing Gate-A unit tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\processing-service')
    .\mvnw.cmd "-Dtest=MeetingWebSocketHandlerTest,ProcessingServiceTest,ProcessingServiceActionPlanTest,AIServiceClientTest,RealtimeEventSubscriberTest,HttpRateLimitFilterTest" test -q
    Pop-Location
}

Invoke-Step 'User-service Gate-A tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID')
    .\mvnw.cmd -pl user-service "-Dtest=UserNotificationServiceTest,JobStatusNotificationServiceTest,BillingServiceTest,QuotaServiceTest,InternalGoogleControllerTest,GoogleGrantServiceTest,HttpRateLimitFilterTest" test -q
    Pop-Location
}

Invoke-Step 'AI-service grouped action plan tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\ai-service')
    if (Test-Path 'scripts\run-tests-docker.ps1') {
        powershell -ExecutionPolicy Bypass -File 'scripts\run-tests-docker.ps1' `
            'tests/test_grouped_action_plan.py' 'tests/test_user_quota_client.py'
    } else {
        python -m pytest tests/test_grouped_action_plan.py tests/test_user_quota_client.py -q
    }
    Pop-Location
}

Invoke-Step 'Processing transcript search boundary tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\processing-service')
    .\mvnw.cmd "-Dtest=ProcessingServiceTranscriptSearchTest" test -q
    Pop-Location
}

Invoke-Step 'AI-service canonicalize deferred retry tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\ai-service')
    if (Test-Path 'scripts\run-tests-docker.ps1') {
        powershell -ExecutionPolicy Bypass -File 'scripts\run-tests-docker.ps1' `
            'tests/test_canonicalize_deferred_retry.py' 'tests/test_internal_transcript_quality.py'
    } else {
        python -m pip install -q -r requirements.txt -r requirements-dev.txt
        python -m pytest tests/test_canonicalize_deferred_retry.py tests/test_internal_transcript_quality.py -q
    }
    Pop-Location
}

Invoke-Step 'Processing Epic3 integration test' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\processing-service')
    .\mvnw.cmd "-Dtest=Epic3EndToEndIT" test -q
    Pop-Location
}

Invoke-Step 'Compose staging config validates' {
    Push-Location (Join-Path $repoRoot 'infra')
    if (-not (Test-Path '.env')) {
        Copy-Item '.env.example' '.env'
    }
    docker compose --env-file .env `
        -f docker-compose.dev.yml `
        -f docker-compose.mvp.yml `
        -f docker-compose.staging.yml config | Out-Null
    Pop-Location
}

Invoke-Step 'Log safety scan' {
    $scanPs1 = Join-Path $repoRoot 'scripts\ci\log-safety-scan.ps1'
    if (Test-Path $scanPs1) {
        powershell -ExecutionPolicy Bypass -File $scanPs1
    } elseif (Test-Path (Join-Path $repoRoot 'scripts\ci\log-safety-scan.sh')) {
        bash (Join-Path $repoRoot 'scripts\ci\log-safety-scan.sh')
    } else {
        Write-Host 'log-safety-scan not found - skipped'
    }
}

Invoke-Step 'Processing multi-replica Redis Streams IT' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\processing-service')
    .\mvnw.cmd "-Dtest=RealtimeEventSubscriberRedisIT" test -q
    Pop-Location
}

Invoke-Step 'AI-service Gemini Redis cooldown IT' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\ai-service')
    if (Test-Path 'scripts\run-tests-docker.ps1') {
        powershell -ExecutionPolicy Bypass -File 'scripts\run-tests-docker.ps1' `
            'tests/test_gemini_redis_cooldown_integration.py'
    } else {
        python -m pip install -q -r requirements.txt -r requirements-dev.txt
        python -m pytest tests/test_gemini_redis_cooldown_integration.py -q
    }
    Pop-Location
}

Invoke-Step 'Contract proto/OpenAPI validation' {
    Push-Location $repoRoot
    npm run validate:contracts
    Pop-Location
}

Invoke-Step 'Google integration unit tests' {
    Push-Location (Join-Path $repoRoot 'FE-Audiomind')
    npm test -- --run src/services/googleIntegration.test.ts
    Pop-Location
}

Invoke-Step 'Meeting-service Google calendar tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID\meeting-service')
    .\mvnw.cmd "-Dtest=GoogleCalendarServiceTest" test -q
    Pop-Location
}

Invoke-Step 'User-service Google internal tests' {
    Push-Location (Join-Path $repoRoot 'demoRecordAUDIOMID')
    .\mvnw.cmd -pl user-service "-Dtest=InternalGoogleControllerTest,GoogleGrantServiceTest" test -q
    Pop-Location
}

Write-Host ''
if ($failures.Count -eq 0) {
    Write-Host 'Gate-A automated verification: ALL PASSED' -ForegroundColor Green
    exit 0
}

Write-Host "Gate-A automated verification: FAILED ($($failures.Count) steps)" -ForegroundColor Red
$failures | ForEach-Object { Write-Host " - $_" }
exit 1
