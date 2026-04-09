param(
    [string]$Namespace = "audiomind",
    [string]$Deployment = "processing-api-deployment",
    [Parameter(Mandatory = $true)]
    [string]$TraceId
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "[TRACE-CHECK] Searching traceId=$TraceId in deployment/$Deployment logs"

$logs = kubectl logs -n $Namespace deployment/$Deployment --tail=500
if ($LASTEXITCODE -ne 0) {
    throw "Failed to fetch logs for deployment/$Deployment"
}

$matched = $logs | Select-String -Pattern $TraceId
if (-not $matched) {
    throw "traceId not found in logs"
}

Write-Host "[TRACE-CHECK] Found trace entries:"
$matched | ForEach-Object { $_.Line }
