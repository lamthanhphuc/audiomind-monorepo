[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [Parameter(Mandatory = $true)]
    [Alias('ServiceName')]
    [ValidateSet('user', 'meeting', 'processing')]
    [string]$Service,

    [ValidateSet('Auto', 'PostgreSQL', 'MySQL')]
    [string]$DatabaseType = 'Auto',

    [string]$DbUser,
    [string]$DbPassword = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

<#
.SYNOPSIS
Open an interactive DB shell for a target service.

.DESCRIPTION
Supports two local profiles:
1) Legacy MySQL split profile:
   - user -> userdb (3306), meeting -> meetingdb (3307), processing -> processingdb (3308)
2) Current Docker dev stack profile (infra/docker-compose.dev.yml):
   - Shared PostgreSQL service (db:5432), default db/user from compose env

.PARAMETER Service
Logical service to inspect: user, meeting, processing.

.PARAMETER DatabaseType
Auto (default), PostgreSQL, or MySQL.
Auto chooses PostgreSQL when a postgres/db container is running; otherwise MySQL.

.PARAMETER DbUser
Database user. Defaults:
- PostgreSQL: $env:POSTGRES_USER or 'audiomind'
- MySQL: 'root'

.PARAMETER DbPassword
Optional password used at runtime only. Never committed.

.NOTES
Use -WhatIf for dry-run command preview.
#>

$mysqlServiceMap = @{
    user = @{
        DbName = 'userdb'
        Port = 3306
        Container = if ($env:DB_INSPECT_USER_CONTAINER) { $env:DB_INSPECT_USER_CONTAINER } else { 'user-mysql' }
    }
    meeting = @{
        DbName = 'meetingdb'
        Port = 3307
        Container = if ($env:DB_INSPECT_MEETING_CONTAINER) { $env:DB_INSPECT_MEETING_CONTAINER } else { 'meeting-mysql' }
    }
    processing = @{
        DbName = 'processingdb'
        Port = 3308
        Container = if ($env:DB_INSPECT_PROCESSING_CONTAINER) { $env:DB_INSPECT_PROCESSING_CONTAINER } else { 'processing-mysql' }
    }
}

$postgresConfig = @{
    DbName = if ($env:POSTGRES_DB) { $env:POSTGRES_DB } else { 'audiomind' }
    Port = 5432
    ContainerCandidates = @(
        if ($env:DB_INSPECT_POSTGRES_CONTAINER) { $env:DB_INSPECT_POSTGRES_CONTAINER } else { 'db' },
        'postgres',
        'postgresql'
    )
}

function Get-RunningContainerNames {
    $rows = docker ps --format "{{.Names}}"
    if (-not $rows) {
        return @()
    }

    return @(
        $rows -split "`n" |
            ForEach-Object { $_.Trim() } |
            Where-Object { $_ }
    )
}

function Find-ContainerByCandidates {
    param(
        [Parameter(Mandatory = $true)]
        [string[]]$Candidates,
        [Parameter(Mandatory = $true)]
        [string[]]$RunningNames
    )

    foreach ($candidate in $Candidates) {
        foreach ($name in $RunningNames) {
            if ($name -eq $candidate -or $name -like "*$candidate*") {
                return $name
            }
        }
    }

    return $null
}

$dockerCmd = Get-Command docker -ErrorAction SilentlyContinue
if ($null -eq $dockerCmd) {
    Write-Error '[db-inspect] Docker CLI not found in PATH.'
    exit 1
}

$runningNames = Get-RunningContainerNames

$selectedDbType = $DatabaseType
if ($DatabaseType -eq 'Auto') {
    $pgContainer = Find-ContainerByCandidates -Candidates $postgresConfig.ContainerCandidates -RunningNames $runningNames
    if ($pgContainer) {
        $selectedDbType = 'PostgreSQL'
    }
    else {
        $selectedDbType = 'MySQL'
    }
}

if ($selectedDbType -eq 'PostgreSQL') {
    $container = Find-ContainerByCandidates -Candidates $postgresConfig.ContainerCandidates -RunningNames $runningNames
    if (-not $container) {
        Write-Error "[db-inspect] PostgreSQL container not running. Expected one of: $($postgresConfig.ContainerCandidates -join ', ')"
        exit 1
    }

    $dbName = [string]$postgresConfig.DbName
    $dbUserResolved = if ($DbUser) { $DbUser } else { if ($env:POSTGRES_USER) { $env:POSTGRES_USER } else { 'audiomind' } }

    Write-Host "[db-inspect] Service: $Service"
    Write-Host "[db-inspect] DatabaseType: PostgreSQL"
    Write-Host "[db-inspect] Target DB: $dbName"
    Write-Host "[db-inspect] Expected host port: $($postgresConfig.Port)"
    Write-Host "[db-inspect] Container: $container"

    if ($DbPassword) {
        $commandPreview = "docker exec -it $container env PGPASSWORD=*** psql -U $dbUserResolved -d $dbName"
        if ($PSCmdlet.ShouldProcess($container, $commandPreview)) {
            docker exec -it $container env "PGPASSWORD=$DbPassword" psql -U $dbUserResolved -d $dbName
        }
    }
    else {
        $commandPreview = "docker exec -it $container psql -U $dbUserResolved -d $dbName"
        if ($PSCmdlet.ShouldProcess($container, $commandPreview)) {
            docker exec -it $container psql -U $dbUserResolved -d $dbName
        }
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Error "[db-inspect] psql shell exited with code $LASTEXITCODE"
        exit $LASTEXITCODE
    }

    exit 0
}

$mysqlConfig = $mysqlServiceMap[$Service]
if ($null -eq $mysqlConfig) {
    Write-Error "[db-inspect] Unsupported service '$Service' for MySQL mode."
    exit 1
}

$container = [string]$mysqlConfig.Container
if (-not ($runningNames | Where-Object { $_ -eq $container })) {
    Write-Error "[db-inspect] MySQL container '$container' is not running. Set DB_INSPECT_*_CONTAINER if your name differs."
    exit 1
}

$dbName = [string]$mysqlConfig.DbName
$dbUserResolved = if ($DbUser) { $DbUser } else { 'root' }

Write-Host "[db-inspect] Service: $Service"
Write-Host "[db-inspect] DatabaseType: MySQL"
Write-Host "[db-inspect] Target DB: $dbName"
Write-Host "[db-inspect] Expected host port: $($mysqlConfig.Port)"
Write-Host "[db-inspect] Container: $container"

if ($DbPassword) {
    $commandPreview = "docker exec -it $container mysql -u $dbUserResolved -p*** $dbName"
    if ($PSCmdlet.ShouldProcess($container, $commandPreview)) {
        # Intentionally pass password only at runtime; never store it in repository.
        docker exec -it $container mysql -u $dbUserResolved "-p$DbPassword" $dbName
    }
}
else {
    $commandPreview = "docker exec -it $container mysql -u $dbUserResolved -p $dbName"
    if ($PSCmdlet.ShouldProcess($container, $commandPreview)) {
        # MySQL will securely prompt for password.
        docker exec -it $container mysql -u $dbUserResolved -p $dbName
    }
}

if ($LASTEXITCODE -ne 0) {
    Write-Error "[db-inspect] mysql shell exited with code $LASTEXITCODE"
    exit $LASTEXITCODE
}

exit 0
