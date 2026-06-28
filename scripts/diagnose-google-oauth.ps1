# Google OAuth / Calendar+Gmail grant diagnostics (local dev)
# Usage: pwsh scripts/diagnose-google-oauth.ps1
# Optional: pwsh scripts/diagnose-google-oauth.ps1 -EnvFile infra/.env

param(
    [string]$EnvFile = "infra/.env",
    [string]$UserApiBase = "http://127.0.0.1:8083",
    [string]$WebBase = "http://127.0.0.1:8080"
)

$ErrorActionPreference = "Continue"
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

function Mask-Value([string]$name, [string]$value) {
    if ($null -eq $value) { return "(missing)" }
    if ($name -match 'SECRET|KEY|TOKEN|PASSWORD') { return "***" }
    return $value
}

function Read-EnvFile([string]$path) {
    $map = @{}
    if (-not (Test-Path $path)) { return $map }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq "" -or $line.StartsWith("#")) { return }
        $idx = $line.IndexOf("=")
        if ($idx -lt 1) { return }
        $key = $line.Substring(0, $idx).Trim()
        $val = $line.Substring($idx + 1).Trim()
        $map[$key] = $val
    }
    return $map
}

Write-Host "`n=== Google OAuth diagnostics ===" -ForegroundColor Cyan
Write-Host "Repo: $root"
Write-Host "Env file: $EnvFile`n"

$envMap = Read-EnvFile $EnvFile
$required = @(
    "GOOGLE_OAUTH_ENABLED",
    "GOOGLE_OAUTH_CLIENT_ID",
    "GOOGLE_OAUTH_CLIENT_SECRET",
    "GOOGLE_OAUTH_REDIRECT_URI",
    "GOOGLE_OAUTH_LINK_REDIRECT_URI",
    "GOOGLE_OAUTH_FRONTEND_BASE_URL",
    "GOOGLE_TOKEN_ENCRYPTION_KEY",
    "GOOGLE_TOKEN_ENCRYPTION_KID",
    "GOOGLE_INTERNAL_SERVICE_TOKEN",
    "VITE_GOOGLE_LOGIN_ENABLED"
)

Write-Host "--- 1) infra/.env ---" -ForegroundColor Yellow
foreach ($key in $required) {
    $val = $envMap[$key]
    $status = if ($val) { "OK" } else { "MISSING" }
    $color = if ($val) { "Green" } else { "Red" }
    Write-Host ("  [{0}] {1} = {2}" -f $status, $key, (Mask-Value $key $val)) -ForegroundColor $color
}

$enabled = $envMap["GOOGLE_OAUTH_ENABLED"] -eq "true"
$viteEnabled = $envMap["VITE_GOOGLE_LOGIN_ENABLED"] -eq "true"
if (-not $enabled) {
    Write-Host "`n  WARN: GOOGLE_OAUTH_ENABLED is not true — link/grant API will return 503." -ForegroundColor Red
}
if (-not $viteEnabled) {
    Write-Host "  WARN: VITE_GOOGLE_LOGIN_ENABLED is not true — rebuild web after setting true." -ForegroundColor Red
}

$loginRedirect = $envMap["GOOGLE_OAUTH_REDIRECT_URI"]
$linkRedirect = $envMap["GOOGLE_OAUTH_LINK_REDIRECT_URI"]
$frontend = $envMap["GOOGLE_OAUTH_FRONTEND_BASE_URL"]

Write-Host "`n--- 2) Redirect URI checklist (must match Google Cloud Console) ---" -ForegroundColor Yellow
Write-Host "  Login callback (user-api):  $loginRedirect"
Write-Host "  Link/grant callback (user-api): $linkRedirect"
Write-Host "  Frontend base (success redirect): $frontend"
Write-Host "  After grant, browser should land on: $frontend/settings/integrations/google/success"

Write-Host "`n--- 3) Docker user-api runtime env ---" -ForegroundColor Yellow
$container = "infra-user-api-1"
$running = docker ps --format "{{.Names}}" 2>$null | Select-String -SimpleMatch $container
if (-not $running) {
    Write-Host "  SKIP: container $container not running. Start: docker compose --env-file $EnvFile -f infra/docker-compose.dev.yml up -d user-api web" -ForegroundColor Red
} else {
    $keys = @(
        "GOOGLE_OAUTH_ENABLED",
        "GOOGLE_OAUTH_CLIENT_ID",
        "GOOGLE_OAUTH_REDIRECT_URI",
        "GOOGLE_OAUTH_LINK_REDIRECT_URI",
        "GOOGLE_OAUTH_FRONTEND_BASE_URL",
        "GOOGLE_TOKEN_ENCRYPTION_KEY",
        "GOOGLE_INTERNAL_SERVICE_TOKEN"
    )
    $raw = docker exec $container printenv 2>$null
    foreach ($key in $keys) {
        $line = $raw | Where-Object { $_ -like "$key=*" } | Select-Object -First 1
        if ($line) {
            $parts = $line -split "=", 2
            Write-Host ("  OK {0} = {1}" -f $parts[0], (Mask-Value $parts[0] $parts[1])) -ForegroundColor Green
        } else {
            Write-Host "  MISSING $key in container" -ForegroundColor Red
        }
    }
}

Write-Host "`n--- 4) HTTP smoke tests ---" -ForegroundColor Yellow
try {
    $ready = Invoke-WebRequest -Uri "$UserApiBase/ready" -UseBasicParsing -TimeoutSec 5
    Write-Host "  OK user-api /ready => $($ready.StatusCode)" -ForegroundColor Green
} catch {
    Write-Host "  FAIL user-api /ready => $($_.Exception.Message)" -ForegroundColor Red
}

try {
    $loginStart = Invoke-WebRequest -Uri "$UserApiBase/auth/google/start?redirect_after=/" -MaximumRedirection 0 -UseBasicParsing -TimeoutSec 5 -ErrorAction SilentlyContinue
    if ($loginStart.StatusCode -eq 302) {
        Write-Host "  OK GET /auth/google/start => 302 redirect to Google" -ForegroundColor Green
    } else {
        Write-Host "  WARN GET /auth/google/start => $($loginStart.StatusCode)" -ForegroundColor Yellow
    }
} catch {
    if ($_.Exception.Response.StatusCode.value__ -eq 302) {
        Write-Host "  OK GET /auth/google/start => 302 redirect to Google" -ForegroundColor Green
    } elseif ($_.Exception.Response.StatusCode.value__ -eq 503) {
        Write-Host "  FAIL GET /auth/google/start => 503 GOOGLE_OAUTH_NOT_CONFIGURED" -ForegroundColor Red
    } else {
        Write-Host "  FAIL GET /auth/google/start => $($_.Exception.Message)" -ForegroundColor Red
    }
}

# link/start requires JWT — expect 401 without token (proves route exists)
try {
    $linkStart = Invoke-WebRequest -Uri "$UserApiBase/auth/google/link/start" -Method POST -ContentType "application/json" -Body "{}" -UseBasicParsing -TimeoutSec 5 -ErrorAction Stop
    Write-Host "  WARN POST /auth/google/link/start => $($linkStart.StatusCode) (expected 401 without JWT)" -ForegroundColor Yellow
} catch {
    $code = $_.Exception.Response.StatusCode.value__ 
    if ($code -eq 401) {
        Write-Host "  OK POST /auth/google/link/start => 401 without JWT (route alive)" -ForegroundColor Green
    } elseif ($code -eq 503) {
        Write-Host "  FAIL POST /auth/google/link/start => 503 (grant not configured — check TOKEN_ENCRYPTION_KEY / INTERNAL_SERVICE_TOKEN)" -ForegroundColor Red
    } else {
        Write-Host "  INFO POST /auth/google/link/start => $code" -ForegroundColor Yellow
    }
}

Write-Host "`n--- 5) Frontend build flag (VITE_GOOGLE_LOGIN_ENABLED) ---" -ForegroundColor Yellow
$webContainer = "infra-web-1"
$webRunning = docker ps --format "{{.Names}}" 2>$null | Select-String -SimpleMatch $webContainer
if (-not $webRunning) {
    Write-Host "  SKIP: $webContainer not running" -ForegroundColor Red
} else {
    $hasGoogleBtn = docker exec $webContainer sh -c "grep -l 'e2e-google-login' /usr/share/nginx/html/assets/*.js 2>/dev/null | head -1" 2>$null
    if ($hasGoogleBtn) {
        Write-Host "  OK web bundle contains Google login button markup" -ForegroundColor Green
    } else {
        Write-Host "  WARN Google login button not found — rebuild web with VITE_GOOGLE_LOGIN_ENABLED=true" -ForegroundColor Red
    }
}

Write-Host "`n--- 6) After OAuth in browser (manual) ---" -ForegroundColor Yellow
Write-Host @"
  1. Login Audiomind, open DevTools -> Network.
  2. Tích hợp -> Kết nối Calendar -> Allow on Google.
  3. Callback tab URL should be:
       $frontend/settings/integrations/google/success?redirectAfter=...
     (or studio tab receives oauth complete message)
  4. Call GET $UserApiBase/users/me/google/status with Authorization: Bearer <JWT>
     Expect grantedScopes contains:
       https://www.googleapis.com/auth/calendar.events
       https://www.googleapis.com/auth/gmail.send
  5. If grantedScopes stays [] after Allow:
       - Google Console -> APIs & Services -> Credentials -> OAuth client
         Authorized redirect URIs MUST include exactly:
           $linkRedirect
           $loginRedirect
       - APIs & Services -> Library: enable 'Google Calendar API' and 'Gmail API'
       - docker logs infra-user-api-1 | findstr GOOGLE_LINK
"@

Write-Host "`n=== Done ===`n" -ForegroundColor Cyan
