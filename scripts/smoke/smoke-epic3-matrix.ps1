param(
    [string]$ProcessingBaseUrl = "http://localhost:8082",
    [string]$MeetingBaseUrl = "http://localhost:8081",
    [string]$UserServiceBaseUrl = "http://localhost:8083",
    [string]$E2EUsername = $env:E2E_USERNAME,
    [string]$E2EPassword = $env:E2E_PASSWORD,
    [long]$MeetingId = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if (-not $E2EUsername -or -not $E2EPassword) {
    throw "E2E_USERNAME and E2E_PASSWORD are required"
}

function Get-AccessToken {
    $body = @{ username = $E2EUsername; password = $E2EPassword } | ConvertTo-Json
    $login = Invoke-RestMethod -Method Post -Uri "$UserServiceBaseUrl/auth/login" `
        -ContentType "application/json" -Body $body
    if (-not $login.accessToken) {
        throw "Login did not return accessToken"
    }
    return $login.accessToken
}

function Invoke-Search {
    param(
        [hashtable]$Headers,
        [long]$Id,
        [string]$Query
    )
    $encoded = [uri]::EscapeDataString($Query)
    return Invoke-RestMethod -Method Get `
        -Uri "$ProcessingBaseUrl/processing/$Id/transcript/search?q=$encoded&limit=5&context=0" `
        -Headers $Headers
}

$token = Get-AccessToken
$headers = @{ Authorization = "Bearer $token" }

if ($MeetingId -le 0) {
    $meetings = Invoke-RestMethod -Method Get -Uri "$MeetingBaseUrl/meetings?sort=recent&limit=5" -Headers $headers
    $items = @($meetings.items)
    if ($items.Count -eq 0 -and $meetings.PSObject.Properties.Name -contains "content") {
        $items = @($meetings.content)
    }
    if ($items.Count -eq 0) {
        throw "No recent meetings found for Epic3 matrix — run smoke-e2e first"
    }
    $MeetingId = [long]$items[0].id
}

Write-Host "[EPIC3-MATRIX] meetingId=$MeetingId"

$matrix = @(
    @{ Query = "ea"; ExpectMatches = 0; Label = "boundary-ea" },
    @{ Query = "email FPT"; ExpectMatches = -1; Label = "phrase-email-fpt" },
    @{ Query = "ke hoach"; ExpectMatches = -1; Label = "diacritic-ke-hoach" },
    @{ Query = "fpt"; ExpectMatches = -1; Label = "proper-noun-fpt" }
)

$failures = @()
foreach ($case in $matrix) {
    $response = Invoke-Search -Headers $headers -Id $MeetingId -Query $case.Query
    $count = @($response.matches).Count
    Write-Host "[EPIC3-MATRIX] $($case.Label) query='$($case.Query)' matches=$count normalized='$($response.normalizedQuery)'"
    if ($case.ExpectMatches -ge 0 -and $count -ne $case.ExpectMatches) {
        $failures += "$($case.Label): expected $($case.ExpectMatches) matches, got $count"
    }
}

Write-Host "[EPIC3-MATRIX] action-plan preview"
$plan = Invoke-RestMethod -Method Get -Uri "$ProcessingBaseUrl/processing/$MeetingId/action-plan" -Headers $headers
if (-not $plan) {
    $failures += "action-plan: empty response"
}

Write-Host "[EPIC3-MATRIX] action-plan DOCX export"
$export = Invoke-WebRequest -Method Get `
    -Uri "$ProcessingBaseUrl/processing/$MeetingId/action-plan/export?format=docx" `
    -Headers $headers
if ($export.StatusCode -ne 200 -or $export.RawContentLength -lt 100) {
    $failures += "action-plan export: unexpected response length=$($export.RawContentLength)"
}

if ($failures.Count -gt 0) {
    $failures | ForEach-Object { Write-Host "FAIL: $_" }
    exit 1
}

Write-Host "[EPIC3-MATRIX] ALL PASSED"
exit 0
