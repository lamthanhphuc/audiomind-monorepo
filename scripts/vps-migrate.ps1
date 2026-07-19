# Thin wrapper for scripts/vps-migrate.sh on Windows.
param(
    [string]$EnvFile = $env:ENV_FILE
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) { $EnvFile = 'infra/.env' }

$bashCandidates = @(
    (Get-Command bash -ErrorAction SilentlyContinue)?.Source,
    'C:\Program Files\Git\bin\bash.exe',
    'C:\Program Files (x86)\Git\bin\bash.exe'
) | Where-Object { $_ -and (Test-Path $_) }

$bash = $bashCandidates | Select-Object -First 1
if ($bash) {
    Push-Location $Root
    try {
        $env:ENV_FILE = $EnvFile
        & $bash ./scripts/vps-migrate.sh
        exit $LASTEXITCODE
    }
    finally {
        Pop-Location
    }
}

Write-Host '[vps-migrate] bash not found; running docker compose migration services directly' -ForegroundColor Yellow

$composeFiles = @('infra/docker-compose.dev.yml', 'infra/docker-compose.mvp.yml', 'infra/docker-compose.prod.yml')
$compose = @('compose', '--env-file', $EnvFile)
foreach ($f in $composeFiles) { $compose += @('-f', $f) }

function Test-ComposeService([string]$Name) {
    $services = & docker @compose config --services 2>$null
    return $services -contains $Name
}

function Invoke-ComposeRun([string]$Service) {
    Write-Host "[vps-migrate] running $Service"
    & docker @compose run --rm $Service
    if ($LASTEXITCODE -ne 0) { throw "migration service $Service failed" }
}

Push-Location $Root
try {
    if (-not (Test-Path $EnvFile)) { throw "missing $EnvFile" }
    foreach ($f in $composeFiles) {
        if (-not (Test-Path $f)) { throw "missing $f" }
    }

    $postgres = if (Test-ComposeService 'db') { 'db' } elseif (Test-ComposeService 'postgres') { 'postgres' } else { throw 'no db/postgres service' }
    & docker @compose up -d $postgres
    if ($LASTEXITCODE -ne 0) { throw "failed to start $postgres" }

    if (Test-ComposeService 'db-flyway-bootstrap') { Invoke-ComposeRun 'db-flyway-bootstrap' }
    if (Test-ComposeService 'user-db-migrate') { Invoke-ComposeRun 'user-db-migrate' } else { throw 'no user-db-migrate service' }
    if (Test-ComposeService 'meeting-db-migrate') { Invoke-ComposeRun 'meeting-db-migrate' } else { throw 'no meeting-db-migrate service' }
    if (Test-ComposeService 'ai-db-migrate') { Invoke-ComposeRun 'ai-db-migrate' } else { throw 'no ai-db-migrate service' }

    Write-Host '[vps-migrate] all migrations completed successfully'
}
finally {
    Pop-Location
}
