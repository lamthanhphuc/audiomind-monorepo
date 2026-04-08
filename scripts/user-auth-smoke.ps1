param(
    [string]$UserBaseUrl = "http://localhost:8083",
    [string]$Username = "smoke_user",
    [string]$Password = "Sm0kePass!123",
    [string]$Email = "smoke_user@example.com"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Write-Step {
    param([string]$Message)
    Write-Host "[USER-SMOKE] $Message"
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

    $jsonBody = $null
    if ($null -ne $Body) {
        if ($Body -is [string]) {
            $jsonBody = $Body
        } else {
            $jsonBody = $Body | ConvertTo-Json -Depth 8
        }
    }

    if ($null -eq $jsonBody) {
        return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers
    }

    return Invoke-RestMethod -Method $Method -Uri $Url -Headers $Headers -ContentType $ContentType -Body $jsonBody
}

Write-Step "Register"
$registerPayload = @{
    username = $Username
    password = $Password
    email = $Email
}

try {
    $registerResp = Invoke-Api -Method "POST" -Url "$UserBaseUrl/api/users/register" -Headers @{} -Body $registerPayload
    Write-Step "Registered userId=$($registerResp.userId)"
} catch {
    Write-Step "Register skipped (user may already exist): $($_.Exception.Message)"
}

Write-Step "Login"
$loginPayload = @{ username = $Username; password = $Password }
$loginResp = Invoke-Api -Method "POST" -Url "$UserBaseUrl/api/users/login" -Headers @{} -Body $loginPayload
if (-not $loginResp.accessToken) {
    throw "Login failed: accessToken missing"
}
$token = [string]$loginResp.accessToken
Write-Step "Login OK userId=$($loginResp.userId)"

$authHeaders = @{ Authorization = "Bearer $token"; "X-Trace-Id" = "smoke-trace-user-001" }

Write-Step "Call /api/users/me (expected 200)"
$meResp = Invoke-Api -Method "GET" -Url "$UserBaseUrl/api/users/me" -Headers $authHeaders -Body $null
Write-Step "me OK username=$($meResp.username)"

Write-Step "Logout"
$null = Invoke-Api -Method "POST" -Url "$UserBaseUrl/api/users/logout" -Headers $authHeaders -Body $null
Write-Step "Logout OK"

Write-Step "Call /api/users/me again (expected 401)"
$unauthorized = $false
try {
    $null = Invoke-Api -Method "GET" -Url "$UserBaseUrl/api/users/me" -Headers $authHeaders -Body $null
} catch {
    if ($_.Exception.Message -match "401") {
        $unauthorized = $true
    }
}

if (-not $unauthorized) {
    throw "Expected 401 after logout, but request succeeded"
}

Write-Step "PASS: register/login/me/logout/reject-after-logout"
