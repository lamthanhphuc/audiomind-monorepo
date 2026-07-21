# Collect a redacted local-stack review bundle (git/docker/logs).
#
# Usage (from repository root):
#   powershell -ExecutionPolicy Bypass -File infra/collect-local-stack-review.ps1
#
# Safety:
# - Does not print or package infra/.env
# - Redacts API keys / secrets in captured output
# - Does not kill processes, delete volumes, or run docker compose down -v
# - Uses relative compose paths (no machine-specific absolute paths)

$ErrorActionPreference = "Continue"

$RepoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $RepoRoot

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outDir = "local-stack-review-$timestamp"
$zipFile = "$outDir.zip"

$composeArgs = @(
    "--env-file", "infra/.env",
    "-f", "infra/docker-compose.dev.yml",
    "-f", "infra/docker-compose.mvp.yml"
)

New-Item -ItemType Directory -Path $outDir -Force | Out-Null

function Redact-Text {
    param([string]$Text)

    if ($null -eq $Text) {
        return ""
    }

    $result = $Text

    # API keys and OAuth secrets.
    $result = $result -replace 'AIza[0-9A-Za-z_-]{20,}', '<REDACTED_GOOGLE_KEY>'
    $result = $result -replace 'AQ\.[0-9A-Za-z._-]{20,}', '<REDACTED_GOOGLE_KEY>'
    $result = $result -replace 'GOCSPX-[0-9A-Za-z_-]{10,}', '<REDACTED_GOOGLE_SECRET>'
    $result = $result -replace '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{10,}', 'Bearer <REDACTED>'
    $result = $result -replace '(?i)([?&]key=)[^&\s]+', '$1<REDACTED>'

    # Alias:key format used by GEMINI_API_KEYS.
    $result = $result -replace `
        '(?i)(primary|backup[0-9]*|gemini[0-9]*):[A-Za-z0-9._+/=-]{15,}', `
        '$1:<REDACTED>'

    $secretNames = @(
        "GEMINI_API_KEY",
        "GEMINI_API_KEYS",
        "DEEPGRAM_API_KEY",
        "GOOGLE_API_KEY",
        "GOOGLE_GENAI_API_KEY",
        "JWT_SECRET",
        "INTERNAL_SERVICE_TOKEN",
        "GOOGLE_INTERNAL_SERVICE_TOKEN",
        "GOOGLE_OAUTH_CLIENT_SECRET",
        "ZOOM_OAUTH_CLIENT_SECRET",
        "TEAMS_OAUTH_CLIENT_SECRET",
        "PAYOS_API_KEY",
        "PAYOS_CHECKSUM_KEY",
        "POSTGRES_PASSWORD",
        "DATABASE_URL",
        "AI_DATABASE_URL",
        "SMTP_PASSWORD"
    )

    foreach ($name in $secretNames) {
        $result = $result -replace `
            "(?im)($name\s*[:=]\s*)[^\s,]+", `
            "`$1<REDACTED>"
    }

    return $result
}

function Save-Command {
    param(
        [string]$FileName,
        [scriptblock]$Command
    )

    try {
        $result = & $Command 2>&1 | Out-String
        Redact-Text $result |
            Set-Content "$outDir/$FileName" -Encoding utf8
    }
    catch {
        Redact-Text ($_ | Out-String) |
            Set-Content "$outDir/$FileName" -Encoding utf8
    }
}

# --------------------------------------------------
# 1. Git
# --------------------------------------------------

Save-Command "git-status.txt" {
    git status --short
}

Save-Command "git-info.txt" {
    git branch --show-current
    git rev-parse --short HEAD
    git log -10 --oneline
}

Save-Command "git-diff-stat.txt" {
    git diff --stat
    git diff --name-status
}

# --------------------------------------------------
# 2. Docker / Compose
# --------------------------------------------------

Save-Command "docker-version.txt" {
    docker --version
    docker compose version
}

Save-Command "compose-services.txt" {
    docker compose @composeArgs config --services
}

Save-Command "compose-images.txt" {
    docker compose @composeArgs config --images
}

Save-Command "compose-ps-all.txt" {
    docker compose @composeArgs ps -a
}

# --------------------------------------------------
# 3. Container state and health
# --------------------------------------------------

$services = docker compose @composeArgs config --services 2>$null

$stateLines = @()

foreach ($service in $services) {
    $ids = docker compose @composeArgs ps -q $service 2>$null

    if (-not $ids) {
        $stateLines += "SERVICE=$service CONTAINER=missing"
        continue
    }

    foreach ($id in $ids) {
        $state = docker inspect `
            --format `
            'name={{.Name}} status={{.State.Status}} exit={{.State.ExitCode}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} restarts={{.RestartCount}} started={{.State.StartedAt}} finished={{.State.FinishedAt}}' `
            $id 2>&1

        $stateLines += "SERVICE=$service $state"
    }
}

$stateLines |
    Set-Content "$outDir/container-states.txt" -Encoding utf8

# --------------------------------------------------
# 4. Migration state and logs
# --------------------------------------------------

$migrationServices = @(
    "db-flyway-bootstrap",
    "user-db-migrate",
    "meeting-db-migrate",
    "ai-db-migrate"
)

foreach ($service in $migrationServices) {
    Save-Command "migration-$service.log" {
        docker compose @composeArgs logs `
            --no-color `
            --timestamps `
            --tail 300 `
            $service
    }
}

# --------------------------------------------------
# 5. Application logs
# --------------------------------------------------

$appServices = @(
    "web",
    "user-api",
    "meeting-api",
    "processing-api",
    "ai-api",
    "celery-worker",
    "celery-beat",
    "db",
    "redis"
)

foreach ($service in $appServices) {
    Save-Command "$service-last-60m.log" {
        docker compose @composeArgs logs `
            --since 60m `
            --no-color `
            --timestamps `
            $service
    }
}

Save-Command "ai-processing-combined-last-30m.log" {
    docker compose @composeArgs logs `
        --since 30m `
        --no-color `
        --timestamps `
        ai-api `
        celery-worker `
        processing-api `
        meeting-api
}

# --------------------------------------------------
# 6. Safe AI configuration fingerprints
# --------------------------------------------------

$pythonProbe = @'
import os
import json
import hashlib

def fingerprint(value):
    if not value:
        return None
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]

def parse_keyset(raw):
    result = []

    for index, item in enumerate((raw or "").split(","), start=1):
        item = item.strip()

        if not item:
            continue

        if ":" in item:
            alias, key = item.split(":", 1)
            alias = alias.strip()
            key = key.strip()
        else:
            alias = f"unnamed-{index}"
            key = item

        result.append({
            "alias": alias,
            "length": len(key),
            "sha256_prefix": fingerprint(key),
            "looks_like_google_key": (
                key.startswith("AIza") or key.startswith("AQ.")
            ),
        })

    return result

single_key = os.getenv("GEMINI_API_KEY", "")
keyset = os.getenv("GEMINI_API_KEYS", "")

data = {
    "component": os.getenv("APP_COMPONENT"),
    "app_env": os.getenv("APP_ENV"),
    "deployment_mode": os.getenv("DEPLOYMENT_MODE"),
    "analysis_provider": os.getenv("ANALYSIS_PROVIDER"),
    "ai_provider": os.getenv("AI_PROVIDER"),
    "analysis_model": os.getenv("GEMINI_ANALYSIS_MODEL"),
    "summary_model": os.getenv("GEMINI_SUMMARY_MODEL"),
    "multi_key_enabled": os.getenv("GEMINI_MULTI_KEY_ENABLED"),
    "max_attempts": os.getenv("GEMINI_MAX_ATTEMPTS"),
    "cooldown_seconds": os.getenv("GEMINI_KEY_COOLDOWN_SECONDS"),
    "hard_cooldown_seconds": os.getenv(
        "GEMINI_KEY_HARD_COOLDOWN_SECONDS"
    ),
    "shared_cooldown_enabled": os.getenv(
        "GEMINI_SHARED_COOLDOWN_ENABLED"
    ),
    "single_key": {
        "present": bool(single_key),
        "length": len(single_key),
        "sha256_prefix": fingerprint(single_key),
    },
    "keyset_fingerprint": fingerprint(keyset),
    "multi_keys": parse_keyset(keyset),
    "stt_provider": os.getenv("STT_PROVIDER"),
    "deepgram_key_present": bool(os.getenv("DEEPGRAM_API_KEY")),
    "deepgram_key_fingerprint": fingerprint(
        os.getenv("DEEPGRAM_API_KEY", "")
    ),
    "speaker_diarization": os.getenv(
        "ENABLE_SPEAKER_DIARIZATION"
    ),
    "deepgram_diarize": os.getenv("DEEPGRAM_DIARIZE"),
    "audio_storage_path": os.getenv("AUDIO_STORAGE_PATH"),
    "allowed_audio_roots": os.getenv(
        "FINAL_AUDIO_ALLOWED_ROOTS"
    ),
}

print(json.dumps(data, indent=2, ensure_ascii=False))
'@

foreach ($service in @("ai-api", "celery-worker")) {
    Save-Command "$service-safe-config.json" {
        docker compose @composeArgs exec -T `
            $service `
            python -c $pythonProbe
    }
}

# --------------------------------------------------
# 7. Host health checks
# --------------------------------------------------

$healthUrls = @(
    "http://127.0.0.1:8080/",
    "http://127.0.0.1:8081/ready",
    "http://127.0.0.1:8082/ready",
    "http://127.0.0.1:8083/ready",
    "http://127.0.0.1:8000/health",
    "http://127.0.0.1:8000/ready"
)

$healthResults = foreach ($url in $healthUrls) {
    try {
        $response = Invoke-WebRequest `
            -Uri $url `
            -UseBasicParsing `
            -TimeoutSec 10

        [PSCustomObject]@{
            Url         = $url
            StatusCode  = $response.StatusCode
            ContentType = $response.Headers["Content-Type"]
            Result      = "PASS"
        }
    }
    catch {
        $statusCode = $null

        if ($_.Exception.Response) {
            try {
                $statusCode = [int]$_.Exception.Response.StatusCode
            }
            catch {
                $statusCode = $null
            }
        }

        [PSCustomObject]@{
            Url         = $url
            StatusCode  = $statusCode
            ContentType = $null
            Result      = $_.Exception.Message
        }
    }
}

$healthResults |
    Format-Table -AutoSize |
    Out-String |
    Set-Content "$outDir/host-health-checks.txt" -Encoding utf8

# --------------------------------------------------
# 8. Resource usage snapshot
# --------------------------------------------------

Save-Command "docker-stats.txt" {
    docker stats --no-stream
}

Save-Command "docker-disk-usage.txt" {
    docker system df
}

# --------------------------------------------------
# 9. Networks and volumes
# --------------------------------------------------

Save-Command "compose-networks.txt" {
    docker network ls
}

Save-Command "compose-volumes.txt" {
    docker volume ls
}

# --------------------------------------------------
# 10. Scan output for possible secrets
# --------------------------------------------------

$dangerPatterns = @(
    'AIza[0-9A-Za-z_-]{20,}',
    'AQ\.[0-9A-Za-z._-]{20,}',
    'GOCSPX-[0-9A-Za-z_-]{10,}',
    '(?i)Bearer\s+[A-Za-z0-9._~+/=-]{10,}',
    '(?i)GEMINI_API_KEY\s*[:=]\s*(?!<REDACTED>)\S+',
    '(?i)DEEPGRAM_API_KEY\s*[:=]\s*(?!<REDACTED>)\S+',
    '(?i)JWT_SECRET\s*[:=]\s*(?!<REDACTED>)\S+',
    '(?i)INTERNAL_SERVICE_TOKEN\s*[:=]\s*(?!<REDACTED>)\S+'
)

$possibleLeaks = @()

foreach ($file in Get-ChildItem $outDir -File) {
    foreach ($pattern in $dangerPatterns) {
        $matches = Select-String `
            -Path $file.FullName `
            -Pattern $pattern `
            -ErrorAction SilentlyContinue

        if ($matches) {
            $possibleLeaks += "$($file.Name): $pattern"
        }
    }
}

if ($possibleLeaks.Count -gt 0) {
    $possibleLeaks |
        Set-Content `
            "$outDir/POSSIBLE-SECRET-LEAKS.txt" `
            -Encoding utf8

    Write-Warning "Có nội dung có thể chứa secret."
    Write-Warning "Kiểm tra POSSIBLE-SECRET-LEAKS.txt trước khi gửi."
}
else {
    "No obvious secret patterns found." |
        Set-Content "$outDir/secret-scan.txt" -Encoding utf8
}

# --------------------------------------------------
# 11. Package
# --------------------------------------------------

Compress-Archive `
    -Path "$outDir/*" `
    -DestinationPath $zipFile `
    -Force

Write-Host ""
Write-Host "Đã tạo: $zipFile"
Write-Host ""
Write-Host "Không gửi infra/.env hoặc docker compose config đầy đủ."
Write-Host "Kiểm tra POSSIBLE-SECRET-LEAKS.txt trước khi upload."
