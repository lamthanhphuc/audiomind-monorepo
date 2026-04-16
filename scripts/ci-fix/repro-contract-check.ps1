param(
    [string]$Branch = 'main',
    [int]$NpmRetries = 3,
    [int]$FetchRetries = 3,
    [string]$LogDir = 'logs/ci-fix'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
    param([string]$Message)
    Write-Host "[ci-fix:contract] $Message"
}

function Invoke-Step {
    param(
        [string]$Name,
        [scriptblock]$Action
    )

    Write-Step "START: $Name"
    & $Action
    Write-Step "PASS: $Name"
}

function Invoke-Retry {
    param(
        [string]$Name,
        [int]$Retries,
        [scriptblock]$Action
    )

    for ($i = 1; $i -le $Retries; $i++) {
        try {
            & $Action
            return
        }
        catch {
            if ($i -ge $Retries) {
                throw "[$Name] failed after $Retries attempts. Last error: $($_.Exception.Message)"
            }
            Write-Step "WARN: $Name failed (attempt $i/$Retries), retrying..."
            Start-Sleep -Seconds (5 * $i)
        }
    }
}

$resolvedLogDir = Join-Path (Get-Location) $LogDir
New-Item -ItemType Directory -Path $resolvedLogDir -Force | Out-Null
$logPath = Join-Path $resolvedLogDir ("repro-contract-check-" + (Get-Date -Format 'yyyyMMdd-HHmmss') + '.log')

Start-Transcript -Path $logPath -Force | Out-Null

try {
    Invoke-Step -Name 'Validate contracts folder' -Action {
        if (-not (Test-Path -LiteralPath 'packages/contracts')) {
            throw 'packages/contracts missing'
        }
    }

    Invoke-Step -Name 'npm ci with retries' -Action {
        Invoke-Retry -Name 'npm ci' -Retries $NpmRetries -Action {
            npm ci
            if ($LASTEXITCODE -ne 0) {
                throw 'npm ci returned non-zero exit code'
            }
        }
    }

    Invoke-Step -Name "git fetch origin $Branch with retries" -Action {
        Invoke-Retry -Name "git fetch origin $Branch" -Retries $FetchRetries -Action {
            git fetch origin $Branch
            if ($LASTEXITCODE -ne 0) {
                throw "git fetch origin $Branch returned non-zero exit code"
            }
        }
    }

    Invoke-Step -Name 'Validate schema' -Action {
        npm run validate:schema
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run validate:schema failed'
        }
    }

    Invoke-Step -Name 'OpenAPI check' -Action {
        npm run check:openapi
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run check:openapi failed'
        }
    }

    Invoke-Step -Name 'Generate client' -Action {
        npm run generate:client
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run generate:client failed'
        }
    }

    Invoke-Step -Name 'Typecheck generated client' -Action {
        npm run typecheck:client
        if ($LASTEXITCODE -ne 0) {
            throw 'npm run typecheck:client failed'
        }
    }

    Invoke-Step -Name 'Check drift' -Action {
        git diff --exit-code -- packages/api-clients
        if ($LASTEXITCODE -ne 0) {
            throw 'git diff detected client drift after generation'
        }
    }

    Write-Step "SUCCESS: contract-check local repro passed. Log: $logPath"
}
finally {
    Stop-Transcript | Out-Null
}