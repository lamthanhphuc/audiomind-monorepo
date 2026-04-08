$ErrorActionPreference = 'Stop'
$namespace = 'audiomind'

Set-Location (Join-Path $PSScriptRoot '..')

Write-Host "[dev] Starting local dependencies with docker compose"
docker compose -f infra/docker-compose.dev.yml up -d --build
if ($LASTEXITCODE -ne 0) {
  throw '[dev] docker compose up -d --build failed'
}

Write-Host "[dev] Running post-build docker reclaim"
npm run docker:clean
if ($LASTEXITCODE -ne 0) {
  Write-Warning '[dev] docker-clean-deep failed, continuing pipeline to avoid blocking development flow'
}

Write-Host "[dev] Building images"
docker build -t audiomind/meeting-api:0.1.0 -f demoRecordAUDIOMID/meeting-service/Dockerfile demoRecordAUDIOMID
docker build -t audiomind/processing-api:0.1.0 -f demoRecordAUDIOMID/processing-service/Dockerfile demoRecordAUDIOMID
docker build -t audiomind/ai-api:0.1.0 demoRecordAUDIOMID/ai-service
docker build -t audiomind/ai-processing-service:0.1.0 demoRecordAUDIOMID/ai-processing-service
docker build -t audiomind/whisper-service:0.1.0 demoRecordAUDIOMID/whisper-service
docker build -t audiomind/diarization-service:0.1.0 demoRecordAUDIOMID/diarization-service

Write-Host "[dev] Applying Kubernetes manifests"
kubectl apply -f k8s/base
kubectl apply -f k8s/deployments
kubectl apply -f k8s/services
kubectl apply -f k8s/hpa
kubectl apply -f k8s/istio
kubectl apply -f k8s/observability

Write-Host "[dev] Waiting for deployments"
kubectl wait --for=condition=available deployment/meeting-api-deployment -n $namespace --timeout=300s
kubectl wait --for=condition=available deployment/processing-api-deployment -n $namespace --timeout=300s
kubectl wait --for=condition=available deployment/ai-api-deployment -n $namespace --timeout=300s

Write-Host "[dev] Running tests"
npm test

Write-Host "[dev] Running config validation"
npm run validate:config:node

if (Test-Path "stress-large-180s.wav") {
  Write-Host "[dev] Audio file found: stress-large-180s.wav"
  Write-Host "[dev] Submit file to API flow as smoke test"
} else {
  Write-Warning "stress-large-180s.wav not found"
}

Write-Host "[dev] Completed"
