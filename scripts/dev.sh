#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NS="audiomind"

cd "$ROOT_DIR"

powershell -ExecutionPolicy Bypass -File ./scripts/docker-clean-deep.ps1

echo "[dev] Building images"
docker build -t audiomind/meeting-api:0.1.0 -f demoRecordAUDIOMID/meeting-service/Dockerfile demoRecordAUDIOMID
docker build -t audiomind/processing-api:0.1.0 -f demoRecordAUDIOMID/processing-service/Dockerfile demoRecordAUDIOMID
docker build -t audiomind/ai-api:0.1.0 demoRecordAUDIOMID/ai-service
docker build -t audiomind/ai-processing-service:0.1.0 demoRecordAUDIOMID/ai-processing-service
docker build -t audiomind/whisper-service:0.1.0 demoRecordAUDIOMID/whisper-service
docker build -t audiomind/diarization-service:0.1.0 demoRecordAUDIOMID/diarization-service

echo "[dev] Applying Kubernetes manifests"
kubectl apply -f k8s/base
kubectl apply -f k8s/deployments
kubectl apply -f k8s/services
kubectl apply -f k8s/hpa
kubectl apply -f k8s/istio
kubectl apply -f k8s/observability

echo "[dev] Waiting for pods to become ready"
kubectl wait --for=condition=available deployment/meeting-api-deployment -n "$NS" --timeout=300s
kubectl wait --for=condition=available deployment/processing-api-deployment -n "$NS" --timeout=300s
kubectl wait --for=condition=available deployment/ai-api-deployment -n "$NS" --timeout=300s

echo "[dev] Running tests"
npm test

echo "[dev] Running config validation"
npm run validate:config:node

echo "[dev] Running real audio flow smoke"
if [[ -f "stress-large-180s.wav" ]]; then
  echo "[dev] Audio file found: stress-large-180s.wav"
  echo "[dev] Use your API endpoint to submit this file in your integration flow"
else
  echo "[dev] WARNING: stress-large-180s.wav not found"
fi

echo "[dev] Completed"
