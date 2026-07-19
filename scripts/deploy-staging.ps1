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

$AppSecretKeys = @("JWT_SECRET", "INTERNAL_SERVICE_TOKEN", "GEMINI_API_KEY", "HUGGINGFACE_TOKEN")
$DbSecretKeys = @(
    "MEETING_DATABASE_URL", "USER_DATABASE_URL", "AI_DATABASE_URL", "DB_USERNAME", "DB_PASSWORD"
)
$CoreDeployments = @(
    "user-api-deployment", "meeting-api-deployment", "processing-api-deployment",
    "ai-api-deployment", "frontend-deployment", "celery-worker-deployment", "celery-beat-deployment"
)

$script:AppSealed = $null
$script:DbSealed = $null
$script:ManagedDbStatus = "SKIPPED"
$script:Phase2Status = "SKIPPED"
$script:GeminiStatus = "SKIPPED"

function Fail([string]$Message) {
    Write-Error $Message
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

function Ensure-Namespace {
    Note "  ensuring namespace $Ns"
    kubectl get namespace $Ns 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
        Note "  namespace $Ns exists"
        return
    }
    kubectl create namespace $Ns | Out-Null
    if ($LASTEXITCODE -ne 0) { Fail "failed to create namespace $Ns" }
    Note "  created namespace $Ns"
}

function Step-GitClean {
    Note "Step 1/17: verify git tree clean"
    if ($env:SKIP_GIT_CLEAN_CHECK -eq "true" -or $env:ALLOW_DIRTY_GIT -eq "true") {
        Note "  skipping git clean check (CI)"
        return
    }
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
    Ensure-Namespace
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
import os
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

image_overrides = {
    "user-db-migrate": os.environ.get("IMAGE_USER_MIGRATE") or os.environ.get("IMAGE_USER_API"),
    "meeting-db-migrate": os.environ.get("IMAGE_MEETING_MIGRATE") or os.environ.get("IMAGE_MEETING_API"),
    "ai-db-migrate": os.environ.get("IMAGE_AI_MIGRATE") or os.environ.get("IMAGE_AI_API"),
}
override = image_overrides.get(job_name)
if override:
    for container in selected.get("spec", {}).get("template", {}).get("spec", {}).get("containers", []):
        container["image"] = override

selected.setdefault("metadata", {})["namespace"] = namespace
out = root / f".deploy-migrate-{job_name}.yaml"
out.write_text(yaml.safe_dump(selected, sort_keys=False), encoding="utf-8")
print(out)
'@
    kubectl apply -f $manifest -n $Ns | Out-Null
    Remove-Item -Force $manifest -ErrorAction SilentlyContinue
    kubectl wait --for=condition=complete "job/$Job" -n $Ns --timeout=$MigrationTimeout
    if ($LASTEXITCODE -ne 0) {
        Note "  $Job failed — collecting logs"
        kubectl logs "job/$Job" -n $Ns --all-containers 2>&1 | ForEach-Object {
            $_ -replace '(?i)(password=)[^\s]+', '$1***'
        }
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

function Set-DeploymentImageIfPresent([string]$Deployment, [string]$Container, [string]$EnvName) {
    $image = [Environment]::GetEnvironmentVariable($EnvName)
    if (-not $image) { return }
    kubectl get deployment $Deployment -n $Ns 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
        Note "  skip image override: deployment/$Deployment not found"
        return
    }
    kubectl set image "deployment/$Deployment" "${Container}=${image}" -n $Ns | Out-Null
    Note "  patched $Deployment/$Container from $EnvName"
}

function Step-ApplyWorkloads {
    Note "Step 13/17: apply deployments/services (post-migration, excluding Jobs)"
    kubectl delete job user-db-migrate meeting-db-migrate ai-db-migrate -n $Ns --ignore-not-found=true 2>$null | Out-Null
    $workloads = python - $Rendered $Ns @'
import sys
from pathlib import Path
import yaml

rendered = Path(sys.argv[1])
namespace = sys.argv[2]
skip_kinds = {"Job", "SealedSecret"}
docs = []
for doc in yaml.safe_load_all(rendered.read_text(encoding="utf-8")):
    if not doc:
        continue
    if doc.get("kind") in skip_kinds:
        continue
    meta = doc.setdefault("metadata", {})
    if meta.get("namespace") in (None, "audiomind", "audiomind-staging"):
        meta["namespace"] = namespace
    docs.append(doc)
out = rendered.parent / ".deploy-workloads.yaml"
with out.open("w", encoding="utf-8") as handle:
    yaml.safe_dump_all(docs, handle, sort_keys=False)
print(out)
'@
    kubectl apply -f $workloads -n $Ns
    if ($LASTEXITCODE -ne 0) { Fail "kubectl apply workloads failed" }
    Remove-Item -Force $workloads -ErrorAction SilentlyContinue
    kubectl apply -f $script:AppSealed -f $script:DbSealed -n $Ns | Out-Null

    Set-DeploymentImageIfPresent "user-api-deployment" "user-api" "IMAGE_USER_API"
    Set-DeploymentImageIfPresent "meeting-api-deployment" "meeting-api" "IMAGE_MEETING_API"
    Set-DeploymentImageIfPresent "processing-api-deployment" "processing-api" "IMAGE_PROCESSING_API"
    Set-DeploymentImageIfPresent "ai-api-deployment" "ai-api" "IMAGE_AI_API"
    Set-DeploymentImageIfPresent "frontend-deployment" "frontend" "IMAGE_FRONTEND"
    Set-DeploymentImageIfPresent "celery-worker-deployment" "celery-worker" "IMAGE_CELERY_WORKER"
    Set-DeploymentImageIfPresent "celery-beat-deployment" "celery-beat" "IMAGE_CELERY_BEAT"
}

function Step-Rollouts {
    Note "Step 14/17: wait for rollout status"
    foreach ($dep in $CoreDeployments) {
        kubectl get deployment $dep -n $Ns 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            Note "  skip rollout: deployment/$dep not present"
            continue
        }
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
    if ($env:RUN_MANAGED_DB_SMOKE -eq "true") {
        python (Join-Path $Root "scripts/smoke-managed-db.py")
        if ($LASTEXITCODE -ne 0) {
            $script:ManagedDbStatus = "FAIL"
            Fail "smoke-managed-db.py failed"
        }
        $script:ManagedDbStatus = "PASS"
    }
    if ($env:RUN_PHASE2_SMOKE -eq "true") {
        python (Join-Path $Root "scripts/smoke-phase2-staging.py")
        if ($LASTEXITCODE -ne 0) {
            $script:Phase2Status = "FAIL"
            Fail "smoke-phase2-staging.py failed"
        }
        $script:Phase2Status = "PASS"
    }
    if ($env:RUN_REAL_GEMINI_SMOKE -eq "true") {
        python (Join-Path $Root "scripts/smoke-real-gemini.py")
        if ($LASTEXITCODE -ne 0) {
            $script:GeminiStatus = "FAIL"
            Fail "smoke-real-gemini.py failed"
        }
        $script:GeminiStatus = "PASS"
    }
    if ($script:ManagedDbStatus -eq "SKIPPED" -and $script:Phase2Status -eq "SKIPPED" -and $script:GeminiStatus -eq "SKIPPED") {
        Note "  skipped (set RUN_MANAGED_DB_SMOKE/RUN_PHASE2_SMOKE/RUN_REAL_GEMINI_SMOKE=true to enable)"
    }
}

function Step-Verdict {
    Note "Step 17/17: verdict"
    Note "STAGING MANIFESTS APPLIED: YES"
    Note "STAGING WORKLOADS HEALTHY: YES"
    switch ($script:ManagedDbStatus) {
        "PASS" { Note "STAGING MANAGED DATABASE VERIFIED: YES" }
        "FAIL" { Note "STAGING MANAGED DATABASE VERIFIED: NO" }
        default { Note "STAGING MANAGED DATABASE VERIFIED: SKIPPED" }
    }
    switch ($script:Phase2Status) {
        "PASS" { Note "STAGING PHASE2 VERIFIED: YES" }
        "FAIL" { Note "STAGING PHASE2 VERIFIED: NO" }
        default { Note "STAGING PHASE2 VERIFIED: SKIPPED" }
    }
    switch ($script:GeminiStatus) {
        "PASS" { Note "STAGING GEMINI VERIFIED: YES" }
        "FAIL" { Note "STAGING GEMINI VERIFIED: NO" }
        default { Note "STAGING GEMINI VERIFIED: SKIPPED" }
    }
    if ($env:RUN_MANAGED_DB_SMOKE -eq "true" -and $env:RUN_PHASE2_SMOKE -eq "true" `
        -and $script:ManagedDbStatus -eq "PASS" -and $script:Phase2Status -eq "PASS") {
        Note "Ready to deploy staging: YES"
    }
    else {
        Note "STAGING INFRA HEALTHY"
        Note "Ready to deploy staging: NO"
    }
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
