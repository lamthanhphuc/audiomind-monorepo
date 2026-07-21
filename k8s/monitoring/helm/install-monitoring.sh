#!/usr/bin/env bash
set -euo pipefail

# Placeholder script. Review values and namespace before running in production.
helm repo add prometheus-community https://prometheus-community.github.io/helm-charts
helm repo add grafana https://grafana.github.io/helm-charts
helm repo update

helm upgrade --install kube-prometheus-stack prometheus-community/kube-prometheus-stack \
  --namespace monitoring \
  --create-namespace \
  -f k8s/monitoring/helm/prometheus-values.yaml

helm upgrade --install loki grafana/loki \
  --namespace monitoring \
  -f k8s/monitoring/helm/loki-values.yaml

# Optional: if using promtail chart separately
helm upgrade --install promtail grafana/promtail \
  --namespace monitoring
