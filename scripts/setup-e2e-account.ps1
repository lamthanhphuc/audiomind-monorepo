param(
    [string]$UserServiceBaseUrl,
    [string]$Username,
    [string]$Password,
    [string]$Email,
    [string]$Plan
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
Ensure a dev/E2E user account exists in user-service with PRO plan.

.DESCRIPTION
- Default account: phucthanhlam / phucthanhlam050204@gmail.com / PRO plan.
- Calls POST /api/users/register (idempotent on existing username/email).
- Updates plan to PRO via Postgres after register or when account already exists.

.NOTES
- Override with E2E_USERNAME, E2E_PASSWORD, E2E_EMAIL, E2E_PLAN, E2E_USER_SERVICE_BASE_URL.
- Postgres: uses docker db container when available, else localhost:5432.
#>

if ([string]::IsNullOrWhiteSpace($UserServiceBaseUrl)) {
    $UserServiceBaseUrl = if ($env:E2E_USER_SERVICE_BASE_URL) { $env:E2E_USER_SERVICE_BASE_URL.TrimEnd('/') } else { 'http://localhost:8083' }
}
if ([string]::IsNullOrWhiteSpace($Username)) {
    $Username = if ($env:E2E_USERNAME) { $env:E2E_USERNAME } else { 'phucthanhlam' }
}
if ([string]::IsNullOrWhiteSpace($Password)) {
    $Password = if ($env:E2E_PASSWORD) { $env:E2E_PASSWORD } else { 'Test@123456' }
}
if ([string]::IsNullOrWhiteSpace($Email)) {
    $Email = if ($env:E2E_EMAIL) { $env:E2E_EMAIL } else { 'phucthanhlam050204@gmail.com' }
}
if ([string]::IsNullOrWhiteSpace($Plan)) {
    $Plan = if ($env:E2E_PLAN) { $env:E2E_PLAN } else { 'PRO' }
}

function Read-DotEnvFile([string]$path) {
    $map = @{}
    if (-not (Test-Path $path)) { return $map }
    Get-Content $path | ForEach-Object {
        $line = $_.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { return }
        $idx = $line.IndexOf('=')
        if ($idx -lt 1) { return }
        $map[$line.Substring(0, $idx).Trim()] = $line.Substring($idx + 1).Trim()
    }
    return $map
}

function Ensure-UserPlan([string]$targetEmail, [string]$targetPlan) {
    $root = Split-Path -Parent $PSScriptRoot
    $envFile = Read-DotEnvFile (Join-Path $root 'infra/.env')
    $pgUser = if ($env:POSTGRES_USER) { $env:POSTGRES_USER } elseif ($envFile['POSTGRES_USER']) { $envFile['POSTGRES_USER'] } else { 'audiomind' }
    $pgDb = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } elseif ($envFile['POSTGRES_DB']) { $envFile['POSTGRES_DB'] } else { 'audiomind' }
    $pgPassword = if ($env:POSTGRES_PASSWORD) { $env:POSTGRES_PASSWORD } elseif ($envFile['POSTGRES_PASSWORD']) { $envFile['POSTGRES_PASSWORD'] } else { 'audiomind' }
    $escapedEmail = $targetEmail.Replace("'", "''")
    $escapedPlan = $targetPlan.Trim().ToUpperInvariant().Replace("'", "''")
    $sql = "UPDATE app_users SET plan = '$escapedPlan', updated_at = NOW() WHERE email = '$escapedEmail';"

    $dbContainer = @(docker ps --format '{{.Names}}' 2>$null | Where-Object { $_ -match 'db' })[0]
    if ($dbContainer) {
        Write-Host "[setup-e2e-account] Setting plan=$escapedPlan for $targetEmail via docker:$dbContainer"
        docker exec $dbContainer psql -U $pgUser -d $pgDb -v ON_ERROR_STOP=1 -c $sql | Out-Host
        return
    }

    Write-Host "[setup-e2e-account] Setting plan=$escapedPlan for $targetEmail via localhost Postgres"
    $prevPgPassword = $env:PGPASSWORD
    $env:PGPASSWORD = $pgPassword
    try {
        & psql -h localhost -p 5432 -U $pgUser -d $pgDb -v ON_ERROR_STOP=1 -c $sql
    } finally {
        if ($null -eq $prevPgPassword) { Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue }
        else { $env:PGPASSWORD = $prevPgPassword }
    }
}

$registerUrl = "$UserServiceBaseUrl/api/users/register"
$payload = @{
    username = $Username
    password = $Password
    email    = $Email
} | ConvertTo-Json -Depth 4

Write-Host "[setup-e2e-account] Ensuring account exists at: $registerUrl"
Write-Host "[setup-e2e-account] Username: $Username | Email: $Email | Plan: $Plan"

$accountReady = $false
$maxAttempts = 6
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        $response = Invoke-RestMethod -Method Post -Uri $registerUrl -ContentType 'application/json' -Body $payload -TimeoutSec 20
        Write-Host "[setup-e2e-account] Registration request completed successfully."
        if ($null -ne $response) {
            Write-Host "[setup-e2e-account] Response: $($response | ConvertTo-Json -Compress)"
        }
        $accountReady = $true
        break
    }
    catch {
        $exception = $_.Exception
        $response = $null

        if ($exception.PSObject.Properties.Match('Response').Count -gt 0) {
            $response = $exception.Response
        }
        elseif ($null -ne $exception.InnerException -and $exception.InnerException.PSObject.Properties.Match('Response').Count -gt 0) {
            $response = $exception.InnerException.Response
        }

        if ($null -ne $response) {
            $statusCode = [int]$response.StatusCode
            $statusDescription = $response.ReasonPhrase
            Write-Warning "[setup-e2e-account] API returned HTTP $statusCode $statusDescription. Treating as success (idempotent ensure-exists behavior)."
            $accountReady = $true
            break
        }

        if ($attempt -lt $maxAttempts) {
            Write-Warning "[setup-e2e-account] Attempt $attempt/$maxAttempts failed to reach user-service: $($exception.Message). Retrying..."
            Start-Sleep -Seconds (5 * $attempt)
            continue
        }

        Write-Error "[setup-e2e-account] Failed to reach user-service: $($exception.Message)"
        exit 1
    }
}

if (-not $accountReady) {
    Write-Error '[setup-e2e-account] Account setup did not complete.'
    exit 1
}

try {
    Ensure-UserPlan -targetEmail $Email -targetPlan $Plan
    Write-Host "[setup-e2e-account] Done. Login with username '$Username' and the configured password; plan should be $Plan."
    exit 0
}
catch {
    Write-Warning "[setup-e2e-account] Account exists but plan update failed: $($_.Exception.Message)"
    Write-Warning '[setup-e2e-account] Start db (docker compose up -d db) and re-run this script, or set plan manually in app_users.'
    exit 0
}
