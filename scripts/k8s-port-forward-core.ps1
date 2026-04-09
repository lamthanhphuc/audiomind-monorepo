param(
    [string]$Namespace = "audiomind"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Write-Host "[K8S-PF] Starting port-forwards in namespace $Namespace"
Write-Host "[K8S-PF] Keep this terminal open while running smoke scripts"

$jobs = @()
$jobs += Start-Job -ScriptBlock { param($ns) kubectl port-forward -n $ns svc/processing-api 8082:8082 } -ArgumentList $Namespace
$jobs += Start-Job -ScriptBlock { param($ns) kubectl port-forward -n $ns svc/ai-api 8000:8000 } -ArgumentList $Namespace
$jobs += Start-Job -ScriptBlock { param($ns) kubectl port-forward -n $ns svc/meeting-api 8081:8081 } -ArgumentList $Namespace
$jobs += Start-Job -ScriptBlock { param($ns) kubectl port-forward -n $ns svc/user-api 8083:8083 } -ArgumentList $Namespace

Write-Host "[K8S-PF] Active background jobs:"
$jobs | Format-Table Id, Name, State
Write-Host "[K8S-PF] Use Get-Job and Stop-Job -Id <id> to stop"
