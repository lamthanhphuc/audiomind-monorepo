param(
    [string]$OutputDirectory = (Join-Path $HOME "Downloads"),
    [int]$Tail = 500
)

$ErrorActionPreference = "Stop"

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$RepoRoot = Resolve-Path (Join-Path $ScriptDir "..\..")
$EnvFile = Join-Path $RepoRoot "infra\.env"
$ComposeDev = Join-Path $RepoRoot "infra\docker-compose.dev.yml"
$ComposeMvp = Join-Path $RepoRoot "infra\docker-compose.mvp.yml"
$Timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$WorkDir = Join-Path ([IO.Path]::GetTempPath()) "audiomind-local-logs-$Timestamp"
$ArchiveName = "audiomind-local-logs-$Timestamp.zip"
$ArchivePath = Join-Path $OutputDirectory $ArchiveName

function Redact-Line {
    param([string]$Line)

    $redacted = $Line
    $redacted = $redacted -replace '(?i)(authorization:\s*bearer\s+)[A-Za-z0-9._~+/\-]+=*', '$1<redacted>'
    $redacted = $redacted -replace '(?i)(bearer\s+)[A-Za-z0-9._~+/\-]+=*', '$1<redacted>'
    $redacted = $redacted -replace '(?i)((api[_-]?key|token|secret|password|authorization|access[_-]?key|refresh[_-]?token)\s*[:=]\s*)("[^"]*"|''[^'']*''|[^,\s;]+)', '$1<redacted>'
    $redacted = $redacted -replace '(?i)((GEMINI|DEEPGRAM|OPENAI|JWT|REDIS|POSTGRES)[A-Z0-9_]*(KEY|TOKEN|SECRET|PASSWORD)\s*=\s*).+', '$1<redacted>'
    return $redacted
}

function Write-RedactedOutput {
    param(
        [string]$Name,
        [scriptblock]$Command
    )

    $Path = Join-Path $WorkDir $Name
    try {
        & $Command 2>&1 |
            ForEach-Object { Redact-Line ([string]$_) } |
            Out-File -FilePath $Path -Encoding utf8
    } catch {
        "COMMAND_FAILED: $($_.Exception.Message)" |
            ForEach-Object { Redact-Line ([string]$_) } |
            Out-File -FilePath $Path -Encoding utf8
    }
}

function Write-EnvCheck {
    $Path = Join-Path $WorkDir "env-redacted-check.txt"
    if (!(Test-Path $EnvFile)) {
        "infra/.env not found" | Out-File -FilePath $Path -Encoding utf8
        return
    }

    Get-Content $EnvFile |
        ForEach-Object {
            $line = [string]$_
            if ($line.Trim() -and !$line.TrimStart().StartsWith("#")) {
                $key = ($line -split "=", 2)[0].Trim()
                if ($key) {
                    "$key=<redacted>"
                }
            }
        } |
        Out-File -FilePath $Path -Encoding utf8
}

function Write-PortCheck {
    $Path = Join-Path $WorkDir "port-check.txt"
    $Ports = @(8080, 8081, 8082, 8083, 8000, 5432, 6379)
    $Lines = @()
    foreach ($Port in $Ports) {
        try {
            $connections = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
            if ($connections) {
                $Lines += "port ${Port}: LISTENING_OR_CONNECTED"
            } else {
                $Lines += "port ${Port}: not observed"
            }
        } catch {
            $result = Test-NetConnection -ComputerName "127.0.0.1" -Port $Port -WarningAction SilentlyContinue
            $Lines += "port ${Port}: TcpTestSucceeded=$($result.TcpTestSucceeded)"
        }
    }
    $Lines | Out-File -FilePath $Path -Encoding utf8
}

if (!(Test-Path $ComposeDev)) {
    throw "Missing local compose file: $ComposeDev"
}
if (!(Test-Path $ComposeMvp)) {
    throw "Missing local compose file: $ComposeMvp"
}

New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

$ComposeArgs = @()
if (Test-Path $EnvFile) {
    $ComposeArgs += @("--env-file", $EnvFile)
}
$ComposeArgs += @("-f", $ComposeDev, "-f", $ComposeMvp)

Push-Location $RepoRoot
try {
    Write-RedactedOutput "compose-ps-a.txt" {
        docker compose @ComposeArgs ps -a
    }
    Write-RedactedOutput "compose-logs-tail.txt" {
        docker compose @ComposeArgs logs --tail $Tail
    }
    Write-RedactedOutput "docker-system-df.txt" {
        docker system df
    }
    Write-RedactedOutput "docker-ps-a.txt" {
        docker ps -a
    }
    Write-EnvCheck
    Write-PortCheck

    if (Test-Path $ArchivePath) {
        Remove-Item -LiteralPath $ArchivePath -Force
    }
    Compress-Archive -Path (Join-Path $WorkDir "*") -DestinationPath $ArchivePath -Force
    Write-Host "Wrote $ArchivePath"
} finally {
    Pop-Location
    Remove-Item -LiteralPath $WorkDir -Recurse -Force -ErrorAction SilentlyContinue
}
