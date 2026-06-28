#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"

failures=()

run_step() {
  local name="$1"
  shift
  echo ""
  echo "=== $name ==="
  if "$@"; then
    echo "PASS: $name"
  else
    echo "FAIL: $name"
    failures+=("$name")
  fi
}

run_step "FE Gate-A unit tests" bash -lc "
  cd FE-Audiomind && npm ci && npm test -- --run \
    src/constants/errorCatalog.test.ts \
    src/services/api.test.ts \
    src/services/billing.test.ts \
    src/services/googleIntegration.test.ts \
    src/services/configService.test.ts \
    src/components/features/BillingScene.test.tsx \
    src/components/features/RealtimeDashboardScene.test.tsx \
    src/components/features/MeetingHistoryScene.test.tsx \
    src/components/dashboard/DashboardLayout.test.tsx \
    src/components/dashboard/GlobalMeetingSearch.test.tsx \
    src/components/features/GlossaryNotesPanel.test.tsx \
    src/components/dashboard/AiAssistant.test.tsx \
    src/components/analysis/AnalysisStatusPanel.test.tsx \
    src/components/transcript/TranscriptDisplay.test.tsx \
    src/hooks/useRealtimeMeetingStream.test.tsx \
    src/components/realtime/AudioRecorderButton.test.tsx
"

run_step "Processing Gate-A unit tests" bash -lc "
  cd demoRecordAUDIOMID/processing-service && chmod +x ../mvnw && ../mvnw -q \
    -Dtest=MeetingWebSocketHandlerTest,ProcessingServiceTest,ProcessingServiceActionPlanTest,AIServiceClientTest,RealtimeEventSubscriberTest,HttpRateLimitFilterTest \
    test
"

run_step "User-service Gate-A tests" bash -lc "
  cd demoRecordAUDIOMID && chmod +x ./mvnw && ./mvnw -pl user-service -q \
    -Dtest=UserNotificationServiceTest,JobStatusNotificationServiceTest,BillingServiceTest,QuotaServiceTest,InternalGoogleControllerTest,GoogleGrantServiceTest,HttpRateLimitFilterTest \
    test
"

run_step "AI-service grouped action plan tests" bash -lc "
  pip install -q -r demoRecordAUDIOMID/ai-service/requirements.txt -r demoRecordAUDIOMID/ai-service/requirements-dev.txt
  cd demoRecordAUDIOMID/ai-service && python -m pytest tests/test_grouped_action_plan.py tests/test_gemini_key_manager.py tests/test_user_quota_client.py -q
"

run_step "Processing transcript search boundary tests" bash -lc "
  cd demoRecordAUDIOMID/processing-service && ../mvnw -q -Dtest=ProcessingServiceTranscriptSearchTest test
"

run_step "AI-service canonicalize deferred retry tests" bash -lc "
  pip install -q -r demoRecordAUDIOMID/ai-service/requirements.txt -r demoRecordAUDIOMID/ai-service/requirements-dev.txt
  cd demoRecordAUDIOMID/ai-service && python -m pytest tests/test_canonicalize_deferred_retry.py tests/test_internal_transcript_quality.py -q
"

run_step "AI-service Celery trace tests" bash -lc "
  pip install -q -r demoRecordAUDIOMID/ai-service/requirements.txt -r demoRecordAUDIOMID/ai-service/requirements-dev.txt
  cd demoRecordAUDIOMID/ai-service && python -m pytest tests/test_celery_trace.py -q
"

run_step "Processing Epic3 integration test" bash -lc "
  cd demoRecordAUDIOMID/processing-service && ../mvnw -q -Dtest=Epic3EndToEndIT test
"

run_step "Meeting-service Google calendar tests" bash -lc "
  cd demoRecordAUDIOMID && ./mvnw -pl meeting-service -q -Dtest=GoogleCalendarServiceTest test
"

run_step "Processing multi-replica Redis Streams IT" bash -lc "
  cd demoRecordAUDIOMID/processing-service && ../mvnw -q -Dtest=RealtimeEventSubscriberRedisIT test
"

run_step "AI-service Gemini Redis cooldown IT" bash -lc "
  pip install -q -r demoRecordAUDIOMID/ai-service/requirements.txt -r demoRecordAUDIOMID/ai-service/requirements-dev.txt
  cd demoRecordAUDIOMID/ai-service && python -m pytest tests/test_gemini_redis_cooldown_integration.py -q
"

run_step "Contract proto/OpenAPI validation" npm run validate:contracts

run_step "Log safety scan" bash scripts/ci/log-safety-scan.sh

if ((${#failures[@]} > 0)); then
  echo ""
  echo "Gate-A automated verification: FAILED (${#failures[@]} steps)"
  printf ' - %s\n' "${failures[@]}"
  exit 1
fi

echo ""
echo "Gate-A automated verification: ALL PASSED"
