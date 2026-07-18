# Seal audiomind app + DB secrets with kubeseal. Never prints plaintext secret values.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$TargetEnvironment = if ($env:TARGET_ENVIRONMENT) { $env:TARGET_ENVIRONMENT } else { "staging" }
$TargetNamespace = $env:TARGET_NAMESPACE
if (-not $TargetNamespace) {
    $TargetNamespace = if ($TargetEnvironment -eq "staging") { "audiomind-staging" } else { "audiomind" }
}

$RequiredAppKeys = @("JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "GEMINI_API_KEY")
$RequiredDbKeys = @(
    "MEETING_DATABASE_URL", "USER_DATABASE_URL", "AI_DATABASE_URL", "DB_USERNAME", "DB_PASSWORD"
)
$PlaceholderPatterns = @(
    "REPLACE_", "CHANGE_ME", "change-me", "changeme", "replace_me",
    "your-managed-db-host", "your_username", "your_password", "managed-db.example"
)

function Fail([string]$Message) {
    Write-Error $Message
    exit 1
}

function Test-Placeholder([string]$Name, [string]$Value) {
    $lower = $Value.ToLowerInvariant()
    foreach ($token in $PlaceholderPatterns) {
        if ($Value.Contains($token) -or $lower.Contains($token.ToLowerInvariant())) {
            Fail "${Name} contains placeholder text"
        }
    }
}

function Require-Env([string]$Name) {
    if (-not $env:$Name) { Fail "missing required env ${Name}" }
}

function Test-JavaDbUrl([string]$Name, [string]$Url) {
    if (-not $Url.StartsWith("jdbc:postgresql://")) {
        Fail "${Name} must start with jdbc:postgresql://"
    }
    if ($TargetEnvironment -in @("staging", "prod")) {
        $lower = $Url.ToLowerInvariant()
        if ($lower -notmatch "sslmode=require" -and $lower -notmatch "sslmode=verify-full") {
            Fail "${Name} must include sslmode=require or sslmode=verify-full for ${TargetEnvironment}"
        }
    }
}

function Test-AiDbUrl([string]$Url) {
    if ($Url.StartsWith("jdbc:")) { Fail "AI_DATABASE_URL must not be JDBC" }
    if ($Url.StartsWith("postgresql+psycopg://") -or $Url.StartsWith("postgresql+asyncpg://")) {
        Fail "AI_DATABASE_URL must use psycopg2 driver (postgresql:// or postgresql+psycopg2://)"
    }
    if (-not ($Url.StartsWith("postgresql://") -or $Url.StartsWith("postgresql+psycopg2://"))) {
        Fail "AI_DATABASE_URL must start with postgresql:// or postgresql+psycopg2://"
    }
    if ($TargetEnvironment -in @("staging", "prod")) {
        $lower = $Url.ToLowerInvariant()
        if ($lower -notmatch "sslmode=require" -and $lower -notmatch "sslmode=verify-full") {
            Fail "AI_DATABASE_URL must include sslmode=require or sslmode=verify-full for ${TargetEnvironment}"
        }
    }
}

function Confirm-EncryptedKeys([string]$File, [string[]]$Keys) {
    $text = Get-Content -Raw -Path $File
    foreach ($key in $Keys) {
        if ($text -notmatch "(?m)^\s${key}:\s") {
            Fail "${File} missing encryptedData key ${key}"
        }
    }
    if ($text -match "REPLACE_WITH_SEALED") {
        Fail "${File} still contains REPLACE_WITH_SEALED placeholder ciphertext"
    }
}

if ($TargetEnvironment -notin @("staging", "prod")) {
    Fail "TARGET_ENVIRONMENT must be staging or prod (got ${TargetEnvironment})"
}

foreach ($key in $RequiredAppKeys) { Require-Env $key; Test-Placeholder $key $env:$key }
if ($env:JWT_SECRET.Length -lt 32) { Fail "JWT_SECRET length $($env:JWT_SECRET.Length) < 32" }

foreach ($key in $RequiredDbKeys) { Require-Env $key; Test-Placeholder $key $env:$key }
Test-JavaDbUrl "MEETING_DATABASE_URL" $env:MEETING_DATABASE_URL
Test-JavaDbUrl "USER_DATABASE_URL" $env:USER_DATABASE_URL
Test-AiDbUrl $env:AI_DATABASE_URL

if (-not (Get-Command kubeseal -ErrorAction SilentlyContinue)) { Fail "kubeseal not found in PATH" }

$TmpDir = New-Item -ItemType Directory -Path (Join-Path $env:TEMP ("audiomind-seal-{0}" -f [guid]::NewGuid())) -Force
$CertFile = $null
$CertIsTemp = $false
try {
    if ($env:KUBESEAL_CERT) {
        if (-not (Test-Path $env:KUBESEAL_CERT)) { Fail "KUBESEAL_CERT file not found: $($env:KUBESEAL_CERT)" }
        $CertFile = $env:KUBESEAL_CERT
    }
    else {
        if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) {
            Fail "kubectl not found; set KUBESEAL_CERT or configure cluster access"
        }
        $CertFile = Join-Path $TmpDir.FullName "sealed-secrets.pem"
        kubeseal --fetch-cert --namespace $TargetNamespace | Set-Content -Path $CertFile -Encoding ascii
        $CertIsTemp = $true
    }

    $OutDir = Join-Path $Root "k8s/overlays/$TargetEnvironment"
    New-Item -ItemType Directory -Path $OutDir -Force | Out-Null
    $AppPlain = Join-Path $TmpDir.FullName "audiomind-secrets.yaml"
    $DbPlain = Join-Path $TmpDir.FullName "audiomind-db-secrets.yaml"
    $AppSealed = Join-Path $OutDir "sealed-secret.generated.yaml"
    $DbSealed = Join-Path $OutDir "sealed-db-secret.generated.yaml"

    $appArgs = @(
        "create", "secret", "generic", "audiomind-secrets",
        "--namespace=$TargetNamespace", "--dry-run=client", "-o", "yaml",
        "--from-literal=JWT_SECRET=$($env:JWT_SECRET)",
        "--from-literal=INTERNAL_SERVICE_TOKEN=$($env:INTERNAL_SERVICE_TOKEN)",
        "--from-literal=GEMINI_API_KEY=$($env:GEMINI_API_KEY)"
    )
    & kubectl @appArgs | Set-Content -Path $AppPlain -Encoding utf8

    $dbArgs = @(
        "create", "secret", "generic", "audiomind-db-secrets",
        "--namespace=$TargetNamespace", "--dry-run=client", "-o", "yaml",
        "--from-literal=MEETING_DATABASE_URL=$($env:MEETING_DATABASE_URL)",
        "--from-literal=USER_DATABASE_URL=$($env:USER_DATABASE_URL)",
        "--from-literal=AI_DATABASE_URL=$($env:AI_DATABASE_URL)",
        "--from-literal=DB_USERNAME=$($env:DB_USERNAME)",
        "--from-literal=DB_PASSWORD=$($env:DB_PASSWORD)"
    )
    & kubectl @dbArgs | Set-Content -Path $DbPlain -Encoding utf8

    Get-Content -Raw $AppPlain | kubeseal --cert $CertFile --format yaml --namespace $TargetNamespace | Set-Content $AppSealed -Encoding utf8
    if ($LASTEXITCODE -ne 0) { Fail "kubeseal failed for app secrets" }
    Get-Content -Raw $DbPlain | kubeseal --cert $CertFile --format yaml --namespace $TargetNamespace | Set-Content $DbSealed -Encoding utf8
    if ($LASTEXITCODE -ne 0) { Fail "kubeseal failed for db secrets" }

    Confirm-EncryptedKeys $AppSealed $RequiredAppKeys
    Confirm-EncryptedKeys $DbSealed $RequiredDbKeys

    Write-Host "Sealed secrets written (no plaintext logged):"
    Write-Host "  $AppSealed"
    Write-Host "  $DbSealed"
    Write-Host "Target namespace: $TargetNamespace"
}
finally {
    Remove-Item -Recurse -Force $TmpDir.FullName -ErrorAction SilentlyContinue
    if ($CertIsTemp -and $CertFile -and (Test-Path $CertFile)) {
        Remove-Item -Force $CertFile -ErrorAction SilentlyContinue
    }
}
