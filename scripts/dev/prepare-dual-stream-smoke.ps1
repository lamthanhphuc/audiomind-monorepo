param(
    [switch]$SkipBuild,
    [switch]$SkipMigration
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
Prepare local stack for dual-stream tab+mic browser smoke test.

.DESCRIPTION
1. Applies scripts/db/dual_stream_migration.sql to Postgres (docker db container or localhost).
2. Rebuilds web, processing-api, ai-api with current infra/.env flags.
3. Restarts those services.

.NOTES
Requires REALTIME_DUAL_STREAM_TAB_MIC_ENABLED=true and VITE_REALTIME_DUAL_STREAM_TAB_MIC=true in infra/.env
#>

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot '..\..')
$infraDir = Join-Path $repoRoot 'infra'
$composeFile = Join-Path $infraDir 'docker-compose.dev.yml'
$migrationFile = Join-Path $repoRoot 'scripts\db\dual_stream_migration.sql'

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

$envFile = Join-Path $infraDir '.env'
$dotenv = Read-DotEnvFile $envFile
$dbName = if ($dotenv['POSTGRES_DB']) { $dotenv['POSTGRES_DB'] } else { 'audiomind' }
$dbUser = if ($dotenv['POSTGRES_USER']) { $dotenv['POSTGRES_USER'] } else { 'audiomind' }

Write-Host "==> Dual-stream smoke prep (repo: $repoRoot)"

if (-not $SkipMigration) {
    if (-not (Test-Path $migrationFile)) {
        throw "Migration file not found: $migrationFile"
    }

    $dbContainer = (docker ps --format '{{.Names}}' | Where-Object { $_ -match 'db' } | Select-Object -First 1)
    if ($dbContainer) {
        Write-Host "==> Applying migration via docker container: $dbContainer"
        Get-Content $migrationFile -Raw | docker exec -i $dbContainer psql -U $dbUser -d $dbName -v ON_ERROR_STOP=1
    }
    else {
        Write-Host "==> Applying migration via localhost:5432"
        $env:PGPASSWORD = if ($dotenv['POSTGRES_PASSWORD']) { $dotenv['POSTGRES_PASSWORD'] } else { 'audiomind' }
        & psql -h localhost -p 5432 -U $dbUser -d $dbName -v ON_ERROR_STOP=1 -f $migrationFile
    }
    Write-Host "==> Migration applied"
}

Push-Location $infraDir
try {
    if (-not $SkipBuild) {
        Write-Host "==> Rebuilding web, processing-api, ai-api..."
        docker compose -f $composeFile build web processing-api ai-api
    }

    Write-Host "==> Restarting services..."
    docker compose -f $composeFile up -d web processing-api ai-api
    docker compose -f $composeFile ps web processing-api ai-api db
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Ready for browser smoke test:"
Write-Host "  1. Open http://localhost:8080"
Write-Host "  2. Realtime -> Tab + Microphone"
Write-Host "  3. Record 20-30s (tab audio + speak into mic)"
Write-Host "  4. Stop and verify Tab/Mic labels in transcript"
Write-Host "  5. DevTools WS: stream_id tab/mic with independent seq"
