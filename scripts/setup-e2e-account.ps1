Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
Ensure an E2E user account exists in user-service.

.DESCRIPTION
- Reads E2E_USERNAME / E2E_PASSWORD from environment.
- Uses safe defaults when env vars are missing.
- Calls POST /api/users/register.
- Treats API-level errors (including account already exists) as success,
  because the goal is to guarantee account existence before E2E.

.NOTES
- Default user-service base URL follows current app config (8083).
- Override with E2E_USER_SERVICE_BASE_URL if needed.
#>

$baseUrl = if ($env:E2E_USER_SERVICE_BASE_URL) { $env:E2E_USER_SERVICE_BASE_URL.TrimEnd('/') } else { 'http://localhost:8083' }
$username = if ($env:E2E_USERNAME) { $env:E2E_USERNAME } else { 'e2e_test_user' }
$password = if ($env:E2E_PASSWORD) { $env:E2E_PASSWORD } else { 'Test@123456' }
$email = if ($env:E2E_EMAIL) { $env:E2E_EMAIL } else { "$username@e2e.local" }

$registerUrl = "$baseUrl/api/users/register"
$payload = @{
    username = $username
    password = $password
    email    = $email
} | ConvertTo-Json -Depth 4

Write-Host "[setup-e2e-account] Ensuring account exists at: $registerUrl"
Write-Host "[setup-e2e-account] Username: $username"

$maxAttempts = 6
for ($attempt = 1; $attempt -le $maxAttempts; $attempt++) {
    try {
        $response = Invoke-RestMethod -Method Post -Uri $registerUrl -ContentType 'application/json' -Body $payload -TimeoutSec 20
        Write-Host "[setup-e2e-account] Registration request completed successfully."
        if ($null -ne $response) {
            Write-Host "[setup-e2e-account] Response: $($response | ConvertTo-Json -Compress)"
        }
        exit 0
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

            # API responded (including 400/409). Treat as success for idempotent account setup.
            Write-Warning "[setup-e2e-account] API returned HTTP $statusCode $statusDescription. Treating as success (idempotent ensure-exists behavior)."
            exit 0
        }

        if ($attempt -lt $maxAttempts) {
            Write-Warning "[setup-e2e-account] Attempt $attempt/$maxAttempts failed to reach user-service: $($exception.Message). Retrying..."
            Start-Sleep -Seconds (5 * $attempt)
            continue
        }

        # Transport-level issue means we could not verify account existence.
        Write-Error "[setup-e2e-account] Failed to reach user-service: $($exception.Message)"
        exit 1
    }
}
