param(
  [string]$UserApiBase = "http://localhost:8083",
  [string]$Username = "admin",
  [string]$Email = "admin@audiomind.local",
  [string]$Password = "Admin@123456",
  [string]$DbHost = "localhost",
  [int]$DbPort = 5432,
  [string]$DbName = "audiomind",
  [string]$DbUser = "audiomind",
  [string]$DbPassword = "audiomind",
  [string]$DbContainer = "",
  [string]$ComposeFile = "infra/docker-compose.mvp.yml",
  [string]$DbService = "db",
  [switch]$UseDockerCompose,
  [switch]$SkipRegister
)

$ErrorActionPreference = "Stop"

function Escape-SqlLiteral([string]$Value) {
  return "'" + ($Value -replace "'", "''") + "'"
}

function Invoke-AdminRegistration {
  if ($SkipRegister) {
    Write-Host "Skipping registration; will only promote existing account."
    return
  }

  $body = @{
    username = $Username
    email = $Email
    password = $Password
  } | ConvertTo-Json

  $registerUrl = "$($UserApiBase.TrimEnd('/'))/api/users/register"
  try {
    Invoke-RestMethod -Method Post -Uri $registerUrl -ContentType "application/json" -Body $body | Out-Null
    Write-Host "Created user '$Username' via $registerUrl."
  } catch {
    $statusCode = $null
    if ($_.Exception.Response -and $_.Exception.Response.StatusCode) {
      $statusCode = [int]$_.Exception.Response.StatusCode
    }

    if ($statusCode -eq 400 -or $statusCode -eq 409) {
      Write-Host "User may already exist; continuing to promote '$Username'."
      return
    }

    throw "Could not register admin user via $registerUrl. Start user-service first, or pass -SkipRegister for an existing user. Original error: $($_.Exception.Message)"
  }
}

function Invoke-AdminPromotion {
  $usernameSql = Escape-SqlLiteral $Username
  $emailSql = Escape-SqlLiteral $Email
  $sql = @"
UPDATE app_users
SET role = 'ADMIN',
    plan = 'PRO',
    updated_at = NOW()
WHERE username = $usernameSql OR email = $emailSql
RETURNING id, username, email, role, plan;
"@

  $psql = Get-Command psql -ErrorAction SilentlyContinue
  if ($psql -and -not $UseDockerCompose) {
    $previousPassword = $env:PGPASSWORD
    try {
      $env:PGPASSWORD = $DbPassword
      $output = & psql -v ON_ERROR_STOP=1 -h $DbHost -p $DbPort -U $DbUser -d $DbName -t -A -F "|" -c $sql
    } finally {
      $env:PGPASSWORD = $previousPassword
    }
  } else {
    $container = $DbContainer
    if (-not $container) {
      $container = (& docker ps --filter "ancestor=postgres:15.7" --format "{{.Names}}" | Select-Object -First 1)
    }
    if (-not $container) {
      $container = (& docker ps --filter "name=db" --format "{{.Names}}" | Select-Object -First 1)
    }

    if ($container) {
      $output = & docker exec -i $container psql -v ON_ERROR_STOP=1 -U $DbUser -d $DbName -t -A -F "|" -c $sql
    } else {
      $output = & docker compose -f infra/docker-compose.dev.yml -f $ComposeFile exec -T $DbService psql -v ON_ERROR_STOP=1 -U $DbUser -d $DbName -t -A -F "|" -c $sql
    }
  }

  $rows = @($output | Where-Object { $_ -and $_.Trim().Length -gt 0 -and $_ -notmatch "UPDATE \d+" })
  if ($LASTEXITCODE -ne 0) {
    throw "Could not promote admin account in PostgreSQL."
  }
  if ($rows.Count -eq 0) {
    throw "No account matched username '$Username' or email '$Email'. Registration may have failed."
  }

  Write-Host "Admin account ready:"
  $rows | ForEach-Object { Write-Host "  $_" }
  Write-Host "Login username: $Username"
  Write-Host "Login password: $Password"
}

Invoke-AdminRegistration
Invoke-AdminPromotion
