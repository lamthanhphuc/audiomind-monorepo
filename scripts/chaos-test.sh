#!/usr/bin/env bash
set -euo pipefail

NS="audiomind"

echo "[chaos] Injecting Istio network fault"
kubectl apply -f k8s/chaos/network-fault.yaml

echo "[chaos] Killing one meeting-api pod"
POD_NAME=$(kubectl get pod -n "$NS" -l app=meeting-api -o jsonpath='{.items[0].metadata.name}')
kubectl delete pod "$POD_NAME" -n "$NS"

echo "[chaos] Scaling meeting-api deployment to zero"
kubectl scale deployment meeting-api-deployment --replicas=0 -n "$NS"
sleep 5
kubectl scale deployment meeting-api-deployment --replicas=1 -n "$NS"

echo "[chaos] Waiting for recovery"
kubectl wait --for=condition=available deployment/meeting-api-deployment -n "$NS" --timeout=180s

echo "[chaos] Done"
