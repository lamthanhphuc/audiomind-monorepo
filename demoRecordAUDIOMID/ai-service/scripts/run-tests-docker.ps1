$ErrorActionPreference = "Stop"
$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "../../..")
$composeFile = Join-Path $repoRoot "infra/docker-compose.dev.yml"
$mvpFile = Join-Path $repoRoot "infra/docker-compose.mvp.yml"
$envFile = Join-Path $repoRoot "infra/.env"
if (-not (Test-Path $envFile)) {
    Copy-Item (Join-Path $repoRoot "infra/.env.example") $envFile
}

Write-Host "Running ai-service tests inside Docker (ai-api image)..."
$pytestArgs = if ($args.Count -gt 0) { $args -join ' ' } else { 'tests/test_user_quota_client.py tests/test_grouped_action_plan.py' }
docker compose --env-file $envFile -f $composeFile -f $mvpFile run --rm --no-deps ai-api `
  sh -c "pip install -q -c constraints.txt -r requirements-dev.txt && python -m pytest $pytestArgs -q"