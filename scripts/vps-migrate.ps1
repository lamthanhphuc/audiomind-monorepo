# Thin wrapper for scripts/vps-migrate.sh on Windows.
param(
    [string]$EnvFile = $env:ENV_FILE
)

$ErrorActionPreference = 'Stop'
$Root = Split-Path -Parent $PSScriptRoot
if (-not $EnvFile) { $EnvFile = '.env.production' }

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

$composeFile = if ($env:COMPOSE_FILE) { $env:COMPOSE_FILE } else { 'infra/docker-compose.vps.yml' }
$compose = @('compose', '--env-file', $EnvFile, '-f', $composeFile)

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
    if (-not (Test-Path $composeFile)) { throw "missing $composeFile" }

    $postgres = if (Test-ComposeService 'postgres') { 'postgres' } elseif (Test-ComposeService 'db') { 'db' } else { throw 'no postgres/db service' }
    & docker @compose up -d $postgres
    if ($LASTEXITCODE -ne 0) { throw "failed to start $postgres" }

    if (Test-ComposeService 'db-flyway-bootstrap') { Invoke-ComposeRun 'db-flyway-bootstrap' }
    if (Test-ComposeService 'user-db-migrate') { Invoke-ComposeRun 'user-db-migrate' }
    elseif (Test-ComposeService 'user-api') {
        & docker @compose run --rm -e SPRING_PROFILES_ACTIVE=migration -e SPRING_FLYWAY_ENABLED=true -e SPRING_MAIN_WEB_APPLICATION_TYPE=none user-api
        if ($LASTEXITCODE -ne 0) { throw 'user-api migration profile failed' }
    }
    if (Test-ComposeService 'meeting-db-migrate') { Invoke-ComposeRun 'meeting-db-migrate' }
    elseif (Test-ComposeService 'meeting-api') {
        & docker @compose run --rm -e SPRING_PROFILES_ACTIVE=migration -e SPRING_FLYWAY_ENABLED=true -e SPRING_MAIN_WEB_APPLICATION_TYPE=none meeting-api
        if ($LASTEXITCODE -ne 0) { throw 'meeting-api migration profile failed' }
    }
    if (Test-ComposeService 'ai-db-migrate') { Invoke-ComposeRun 'ai-db-migrate' }

    Write-Host '[vps-migrate] all migrations completed successfully'
}
finally {
    Pop-Location
}
