SHELL := /bin/bash

.PHONY: clean compose-up build deploy wait test stress chaos dev dev-compose

clean:
	npm run docker:clean

compose-up:
	docker compose -f infra/docker-compose.dev.yml up -d --build
	npm run docker:clean

build:
	docker build -t audiomind/meeting-api:0.1.0 -f demoRecordAUDIOMID/meeting-service/Dockerfile demoRecordAUDIOMID
	docker build -t audiomind/processing-api:0.1.0 -f demoRecordAUDIOMID/processing-service/Dockerfile demoRecordAUDIOMID
	docker build -t audiomind/ai-api:0.1.0 demoRecordAUDIOMID/ai-service
	docker build -t audiomind/ai-processing-service:0.1.0 demoRecordAUDIOMID/ai-processing-service
	docker build -t audiomind/whisper-service:0.1.0 demoRecordAUDIOMID/whisper-service
	docker build -t audiomind/diarization-service:0.1.0 demoRecordAUDIOMID/diarization-service

deploy:
	kubectl apply -f k8s/base
	kubectl apply -f k8s/deployments
	kubectl apply -f k8s/services
	kubectl apply -f k8s/hpa
	kubectl apply -f k8s/istio
	kubectl apply -f k8s/observability

wait:
	kubectl wait --for=condition=available deployment/meeting-api-deployment -n audiomind --timeout=300s
	kubectl wait --for=condition=available deployment/processing-api-deployment -n audiomind --timeout=300s
	kubectl wait --for=condition=available deployment/ai-api-deployment -n audiomind --timeout=300s

test:
	npm test
	npm run validate:config:node

stress:
	k6 run stress-tests/k6-10-jobs.js

chaos:
	kubectl apply -f k8s/chaos/network-fault.yaml
	kubectl delete pod -n audiomind -l app=meeting-api --grace-period=0 --force || true

dev: clean build deploy wait test
	@echo "Dev pipeline completed"

dev-compose: compose-up build deploy wait test
	@echo "Dev compose pipeline completed"
