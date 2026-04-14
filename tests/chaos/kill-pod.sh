#!/usr/bin/env bash
set -euo pipefail

# Usage:
# NAMESPACE=audiomind-staging ./tests/chaos/kill-pod.sh

NAMESPACE="${NAMESPACE:-audiomind-staging}"
LABEL_SELECTOR="${LABEL_SELECTOR:-app in (user-api,processing-api,meeting-api,ai-api)}"

POD="$(kubectl get pods -n "$NAMESPACE" -l "$LABEL_SELECTOR" -o jsonpath='{.items[0].metadata.name}')"
if [[ -z "$POD" ]]; then
  echo "No pod found in namespace=$NAMESPACE with selector=$LABEL_SELECTOR"
  exit 1
fi

echo "Deleting pod: $POD"
kubectl delete pod "$POD" -n "$NAMESPACE"

echo "Waiting for self-healing rollout"
kubectl rollout status deployment/user-api-deployment -n "$NAMESPACE" --timeout=180s || true
kubectl rollout status deployment/processing-api-deployment -n "$NAMESPACE" --timeout=180s || true
kubectl rollout status deployment/meeting-api-deployment -n "$NAMESPACE" --timeout=180s || true
kubectl rollout status deployment/ai-api-deployment -n "$NAMESPACE" --timeout=180s || true

echo "Chaos check completed"
