# Fail-closed staging deploy orchestrator. Never logs secret values.
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Overlay = if ($env:K8S_OVERLAY) { $env:K8S_OVERLAY } else { Join-Path $Root "k8s/overlays/staging" }
$Ns = if ($env:K8S_NAMESPACE) { $env:K8S_NAMESPACE } else { "audiomind-staging" }
$ExpectedContext = $env:K8S_CONTEXT
$Rendered = Join-Path $Root "rendered-staging.yaml"
$MigrationTimeout = if ($env:MIGRATION_TIMEOUT) { $env:MIGRATION_TIMEOUT } else { "900s" }
$RolloutTimeout = if ($env:ROLLOUT_TIMEOUT) { $env:ROLLOUT_TIMEOUT } else { "600s" }

$AppSecretKeys = @("JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "GEMINI_API_KEY")
$DbSecretKeys = @(
    "MEETING_DATABASE_URL", "USER_DATABASE_URL", "AI_DATABASE_URL", "DB_USERNAME", "DB_PASSWORD"
)
$CoreDeployments = @(
    "user-api-deployment", "meeting-api-deployment", "processing-api-deployment",
    "ai-api-deployment", "celery-worker-deployment", "celery-beat-deployment"
)

$script:AppSealed = $null
$script:DbSealed = $null

function Fail([string]$Message) {
    Write-Error $Message
    Write-Host "NOT READY"
    exit 1
}

function Note([string]$Message) { Write-Host $Message }

function Resolve-SealedFile([string]$Base) {
    foreach ($candidate in @(
        (Join-Path $Overlay "$Base.generated.yaml"),
        (Join-Path $Overlay "$Base.yaml")
    )) {
        if (Test-Path $candidate) { return $candidate }
    }
    return $null
}

function Step-GitClean {
    Note "Step 1/17: verify git tree clean"
    Push-Location $Root
    try {
        $status = git status --porcelain
        if (-not $status) { Note "  git tree clean"; return }
        $filtered = $status | Where-Object { $_ -notmatch '^\?\? rendered-.*\.yaml$' }
        if ($filtered) {
            $filtered | Write-Host
            Fail "git tree not clean (untracked rendered-*.yaml ignored)"
        }
        Note "  clean aside from ignored rendered-*.yaml"
    }
    finally { Pop-Location }
}

function Step-KubectlContext {
    Note "Step 2/17: verify kubectl context/namespace"
    if (-not (Get-Command kubectl -ErrorAction SilentlyContinue)) { Fail "kubectl not found" }
    $ctx = kubectl config current-context 2>$null
    if (-not $ctx) { Fail "no kubectl current-context" }
    if ($ExpectedContext -and $ctx -ne $ExpectedContext) {
        Fail "kubectl context '$ctx' != expected '$ExpectedContext'"
    }
    Note "  context=$ctx"
    kubectl get namespace $Ns 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Note "  namespace $Ns exists" }
    else { Note "  namespace $Ns will be created during apply" }
}

function Step-SealedSecrets {
    Note "Step 3/17: verify SealedSecret ciphertext files"
    $script:AppSealed = Resolve-SealedFile "sealed-secret"
    $script:DbSealed = Resolve-SealedFile "sealed-db-secret"
    if (-not $script:AppSealed) { Fail "missing sealed-secret.generated.yaml or sealed-secret.yaml" }
    if (-not $script:DbSealed) { Fail "missing sealed-db-secret.generated.yaml or sealed-db-secret.yaml" }
    foreach ($file in @($script:AppSealed, $script:DbSealed)) {
        if ((Get-Content -Raw $file) -match "REPLACE_WITH_SEALED") {
            Fail "$file contains REPLACE_WITH_SEALED placeholder"
        }
    }
    Note "  app=$($script:AppSealed)"
    Note "  db=$($script:DbSealed)"
}

function Step-Render {
    Note "Step 4/17: render staging overlay"
    $base = "$Rendered.base"
    kubectl kustomize $Overlay | Set-Content -Path $base -Encoding utf8
    Get-Content $base, $script:AppSealed, $script:DbSealed | Set-Content -Path $Rendered -Encoding utf8
    Remove-Item $base -Force -ErrorAction SilentlyContinue
    Note "  wrote $Rendered"
}

function Step-ValidateRendered {
    Note "Step 5/17: validate rendered manifest (deploy-ready)"
    python (Join-Path $Root "scripts/validate-rendered-k8s.py") $Rendered --environment staging --deploy-ready
    if ($LASTEXITCODE -ne 0) { Fail "validate-rendered-k8s.py failed" }
}

function Step-Kubeconform {
    Note "Step 6/17: kubeconform (optional)"
    if (-not (Get-Command kubeconform -ErrorAction SilentlyContinue)) {
        Note "  kubeconform not installed; skipping"
        return
    }
    kubeconform -strict -summary -ignore-missing-schemas $Rendered
    if ($LASTEXITCODE -ne 0) { Fail "kubeconform failed" }
}

function Step-ApplySecrets {
    Note "Step 7/17: apply namespace/config/secrets"
    kubectl apply -f (Join-Path $Root "k8s/base/namespace.yaml") 2>$null | Out-Null
    kubectl apply -f $script:AppSealed -n $Ns
    kubectl apply -f $script:DbSealed -n $Ns
    $cm = Join-Path $Overlay "configmap-patch.yaml"
    if (Test-Path $cm) { kubectl apply -f $cm -n $Ns 2>$null | Out-Null }
}

function Step-WaitSecrets {
    Note "Step 8/17: wait for Secrets from SealedSecrets"
    $deadline = (Get-Date).AddSeconds(120)
    while ((Get-Date) -lt $deadline) {
        $appOk = kubectl get secret audiomind-secrets -n $Ns 2>$null; $app = $LASTEXITCODE -eq 0
        $dbOk = kubectl get secret audiomind-db-secrets -n $Ns 2>$null; $db = $LASTEXITCODE -eq 0
        if ($app -and $db) {
            Note "  audiomind-secrets + audiomind-db-secrets present"
            return
        }
        Start-Sleep -Seconds 3
    }
    Fail "timed out waiting for Secrets in $Ns"
}

function Step-ValidateSecretKeys {
    Note "Step 9/17: validate Secret keys (values not printed)"
    foreach ($key in $AppSecretKeys) {
        $val = kubectl get secret audiomind-secrets -n $Ns -o "jsonpath={.data.$key}" 2>$null
        if (-not $val) { Fail "audiomind-secrets missing key $key" }
    }
    foreach ($key in $DbSecretKeys) {
        $val = kubectl get secret audiomind-db-secrets -n $Ns -o "jsonpath={.data.$key}" 2>$null
        if (-not $val) { Fail "audiomind-db-secrets missing key $key" }
    }
    Note "  required keys present"
}

function Invoke-MigrationJob([string]$Job) {
    Note "  migration job $Job"
    kubectl delete job $Job -n $Ns --ignore-not-found=true 2>$null | Out-Null
    $manifest = python - $Job $Ns $Root @'
import sys
from pathlib import Path
import yaml

job_name, namespace, root = sys.argv[1], sys.argv[2], Path(sys.argv[3])
jobs_file = root / "k8s/jobs/db-migrate-jobs.yaml"
docs = list(yaml.safe_load_all(jobs_file.read_text(encoding="utf-8")))
selected = None
for doc in docs:
    if doc and doc.get("kind") == "Job" and doc.get("metadata", {}).get("name") == job_name:
        selected = doc
        break
if not selected:
    raise SystemExit(f"job {job_name} not found in {jobs_file}")
selected.setdefault("metadata", {})["namespace"] = namespace
out = root / f".deploy-migrate-{job_name}.yaml"
out.write_text(yaml.safe_dump(selected, sort_keys=False), encoding="utf-8")
print(out)
'@
    kubectl apply -f $manifest -n $Ns | Out-Null
    Remove-Item -Force $manifest -ErrorAction SilentlyContinue
    kubectl wait --for=condition=complete "job/$Job" -n $Ns --timeout=$MigrationTimeout
    if ($LASTEXITCODE -ne 0) {
        Note "  $Job failed — inspect: kubectl logs job/$Job -n $Ns"
        Note "  DB migrations are NOT auto-rolled back. Fix schema/DSN and re-run this job."
        Fail "$Job did not complete"
    }
    Note "  $Job complete"
}

function Step-Migrations {
    Note "Step 10/17: user-db-migrate"
    Invoke-MigrationJob "user-db-migrate"
    Note "Step 11/17: meeting-db-migrate"
    Invoke-MigrationJob "meeting-db-migrate"
    Note "Step 12/17: ai-db-migrate"
    Invoke-MigrationJob "ai-db-migrate"
}

function Step-ApplyWorkloads {
    Note "Step 13/17: apply deployments/services (full overlay)"
    kubectl apply -k $Overlay -n $Ns
    kubectl apply -f $script:AppSealed -f $script:DbSealed -n $Ns | Out-Null
}

function Step-Rollouts {
    Note "Step 14/17: wait for rollout status"
    foreach ($dep in $CoreDeployments) {
        kubectl rollout status "deployment/$dep" -n $Ns --timeout=$RolloutTimeout
        if ($LASTEXITCODE -ne 0) {
            Note "  rollout failed for $dep"
            Note "  App rollback guidance: kubectl rollout undo deployment/$dep -n $Ns"
            Note "  Or pin previous image: kubectl set image deployment/$dep <container>=<image:tag> -n $Ns"
            Fail "rollout failed for $dep"
        }
    }
}

function Step-Health {
    Note "Step 15/17: health checks (/ready)"
    $env:K8S_NAMESPACE = $Ns
    bash (Join-Path $Root "scripts/ci/verify-ready-staging.sh")
    if ($LASTEXITCODE -ne 0) { Fail "verify-ready-staging failed" }
}

function Step-Smokes {
    Note "Step 16/17: optional smoke tests"
    $ran = $false
    if ($env:RUN_MANAGED_DB_SMOKE -eq "true") {
        python (Join-Path $Root "scripts/smoke-managed-db.py")
        if ($LASTEXITCODE -ne 0) { Fail "smoke-managed-db.py failed" }
        $ran = $true
    }
    if ($env:RUN_PHASE2_SMOKE -eq "true") {
        python (Join-Path $Root "scripts/smoke-phase2-staging.py")
        if ($LASTEXITCODE -ne 0) { Fail "smoke-phase2-staging.py failed" }
        $ran = $true
    }
    if ($env:RUN_REAL_GEMINI_SMOKE -eq "true") {
        python (Join-Path $Root "scripts/smoke-real-gemini.py")
        if ($LASTEXITCODE -ne 0) { Fail "smoke-real-gemini.py failed" }
        $ran = $true
    }
    if (-not $ran) {
        Note "  skipped (set RUN_MANAGED_DB_SMOKE/RUN_PHASE2_SMOKE/RUN_REAL_GEMINI_SMOKE=true to enable)"
    }
}

function Step-Verdict {
    Note "Step 17/17: verdict"
    Note "READY TO DEPLOY STAGING"
}

Step-GitClean
Step-KubectlContext
Step-SealedSecrets
Step-Render
Step-ValidateRendered
Step-Kubeconform
Step-ApplySecrets
Step-WaitSecrets
Step-ValidateSecretKeys
Step-Migrations
Step-ApplyWorkloads
Step-Rollouts
Step-Health
Step-Smokes
Step-Verdict
