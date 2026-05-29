package com.example.processingservice.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.time.Instant;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.ProcessStartResponse;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.annotation.PostConstruct;
import lombok.RequiredArgsConstructor;

@Service
@RequiredArgsConstructor
public class ProcessingService {
    private static final Set<String> ALLOWED_UPLOAD_LANGUAGES = Set.of("vi", "en", "multi");
    private static final String REALTIME_ANALYSIS_SOURCE_GET_ANALYSIS_LAZY = "get_analysis_lazy";
    private static final String MEETING_STATUS_PROCESSING = "processing";
    private static final String MEETING_STATUS_COMPLETED = "completed";
    private static final String MEETING_STATUS_FAILED = "failed";

    private static final Logger log = LoggerFactory.getLogger(ProcessingService.class);

    private final AIServiceClient aiServiceClient;
    private final MeetingServiceClient meetingServiceClient;
    private final JobStateStore jobStateStore;
    private final MeterRegistry meterRegistry;
    @Value("${processing.analysis.prompt-version:gemini-business-v1}")
    private String analysisPromptVersion;
    @Value("${processing.analysis.schema-version:gemini-business-v1}")
    private String analysisSchemaVersion;

    private final AtomicInteger runningGauge = new AtomicInteger(0);
    private final Set<Long> activeJobs = Collections.newSetFromMap(new ConcurrentHashMap<>());

    @PostConstruct
    void initMetrics() {
        meterRegistry.gauge("jobs_running", runningGauge);
    }

    public ProcessStartResponse startProcessing(Long meetingId) {
        return startProcessing(meetingId, null, null, null, null, "vi", null, null);
    }

    public ProcessStartResponse startProcessing(
            Long meetingId,
            String audioPath,
            String fileId,
            String topic,
            List<String> glossaryTerms,
            String language,
            String traceId
    ) {
        return startProcessing(meetingId, audioPath, fileId, topic, glossaryTerms, language, traceId, null);
    }

    public ProcessStartResponse startProcessing(
            Long meetingId,
            String audioPath,
            String fileId,
            String topic,
            List<String> glossaryTerms,
            String language,
            String traceId,
            String authorization
    ) {
        try (MDC.MDCCloseable ignored = MDC.putCloseable("jobId", String.valueOf(meetingId))) {
            String resolvedFileId = resolveFileId(fileId, audioPath, meetingId);
            JobStateStore.IdempotencyClaim claim = jobStateStore.claimIdempotency(resolvedFileId, meetingId);
            if (!claim.owner()) {
                Long existingJobId = claim.jobId();
                log.info(
                        "event=ANALYSIS_TRIGGER_SKIPPED traceId={} requestId={} meetingId={} source=batch reason=idempotency_hit",
                        traceId,
                        currentRequestId(traceId),
                        existingJobId
                );
                ProcessingStatusResponse existing = getProcessingStatus(existingJobId, traceId, authorization);
                syncMeetingStatusSafely(existingJobId, existing.status(), traceId, authorization);
                return new ProcessStartResponse(existing.meetingId(), existing.status(), existing.error(), existing.updatedAt());
            }

            jobStateStore.upsertJobState(meetingId, "QUEUED", resolvedFileId, null, null, traceId);
            incrementJobsTotal("QUEUED");
            syncMeetingStatusSafely(meetingId, "QUEUED", traceId, authorization);
            log.info(
                    "event=ANALYSIS_TRIGGER_REQUEST traceId={} requestId={} meetingId={} source=batch analysisStatus=QUEUED",
                    traceId,
                    currentRequestId(traceId),
                    meetingId
            );

            try {
                processMeeting(meetingId, audioPath, resolvedFileId, topic, glossaryTerms, language, traceId, authorization);
            } catch (HttpStatusCodeException ex) {
                jobStateStore.upsertJobState(meetingId, "FAILED", resolvedFileId, null, ex.getMessage(), traceId);
                incrementJobsTotal("FAILED");
                syncMeetingStatusSafely(meetingId, "FAILED", traceId, authorization);
                int downstreamStatus = ex.getStatusCode().value();
                log.warn(
                        "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=batch httpStatus={} errorCode=DOWNSTREAM_HTTP_ERROR",
                        traceId,
                        currentRequestId(traceId),
                        meetingId,
                        downstreamStatus
                );
                if (downstreamStatus == HttpStatus.SERVICE_UNAVAILABLE.value()) {
                    throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI service unavailable");
                }
                throw ex;
            } catch (Exception ex) {
                jobStateStore.upsertJobState(meetingId, "FAILED", resolvedFileId, null, ex.getMessage(), traceId);
                incrementJobsTotal("FAILED");
                syncMeetingStatusSafely(meetingId, "FAILED", traceId, authorization);
                log.warn(
                        "event=ANALYSIS_TRIGGER_FAILED traceId={} requestId={} meetingId={} source=batch errorCode={}",
                        traceId,
                        currentRequestId(traceId),
                        meetingId,
                        ex.getClass().getSimpleName()
                );
                throw ex;
            }

            ProcessingStatusResponse status = getProcessingStatus(meetingId, traceId, authorization);
            syncMeetingStatusSafely(meetingId, status.status(), traceId, authorization);
            return new ProcessStartResponse(status.meetingId(), status.status(), status.error(), status.updatedAt());
        }
    }

    public Map<String, Object> processMeeting(
            Long meetingId,
            String audioPath,
            String fileId,
            String topic,
            List<String> glossaryTerms,
            String language,
            String traceId
    ) {
        return processMeeting(meetingId, audioPath, fileId, topic, glossaryTerms, language, traceId, null);
    }

    public Map<String, Object> processMeeting(
            Long meetingId,
            String audioPath,
            String fileId,
            String topic,
            List<String> glossaryTerms,
            String language,
            String traceId,
            String authorization
    ) {
        String resolvedAudioPath = audioPath;
        String resolvedLanguage = normalizeBatchLanguage(language);
        if (resolvedAudioPath == null || resolvedAudioPath.isBlank()) {
            try {
                Map<String, Object> meeting = meetingServiceClient.getMeetingById(meetingId, traceId, authorization);
                Object audioPathObj = meeting.get("audioPath");
                if (audioPathObj == null || String.valueOf(audioPathObj).isBlank()) {
                    throw new IllegalArgumentException("Meeting has no audioPath: " + meetingId);
                }
                resolvedAudioPath = String.valueOf(audioPathObj);
                if ("vi".equals(resolvedLanguage)) {
                    Object meetingLanguage = meeting.get("language");
                    resolvedLanguage = normalizeBatchLanguage(meetingLanguage == null ? null : String.valueOf(meetingLanguage));
                }
            } catch (Exception ex) {
                if (audioPath == null || audioPath.isBlank()) {
                    log.warn("[traceId={}] [jobId={}] Meeting {} not found and no audioPath provided", traceId, meetingId, meetingId);
                    throw new IllegalArgumentException("Meeting not found and audioPath is required for meetingId: " + meetingId, ex);
                }
                resolvedAudioPath = audioPath;
                log.info("[traceId={}] [jobId={}] Meeting {} not found, proceeding with provided audioPath", traceId, meetingId, meetingId);
            }
        }
        log.info(
                "event=BATCH_STT_EFFECTIVE_CONFIG traceId={} requestId={} meetingId={} source=upload requestedLanguage={} effectiveLanguage={}",
                traceId,
                currentRequestId(traceId),
                meetingId,
                language == null ? "" : language,
                resolvedLanguage
        );

        Map<String, Object> aiResponse = aiServiceClient.processAudio(
                meetingId,
                resolvedAudioPath,
                fileId,
                topic,
                glossaryTerms,
                resolvedLanguage,
                traceId,
                authorization
        );
        log.info(
                "event=UPLOAD_TRANSCRIPT_STARTED traceId={} requestId={} meetingId={} source=upload",
                traceId,
                currentRequestId(traceId),
                meetingId
        );
        return aiResponse;
    }

    public Map<String, Object> uploadAudio(MultipartFile file, String traceId) {
        return uploadAudio(file, traceId, null);
    }

    public Map<String, Object> uploadAudio(MultipartFile file, String traceId, String authorization) {
        log.info(
                "event=UPLOAD_REQUEST_RECEIVED traceId={} requestId={} source=upload path=/processing/upload",
                traceId,
                currentRequestId(traceId)
        );
        return aiServiceClient.uploadAudio(file, traceId, authorization);
    }

    /**
     * Upload audio file asynchronously to avoid blocking the request thread on large uploads.
     * Returns a CompletableFuture that completes when upload finishes.
     */
    public java.util.concurrent.CompletableFuture<Map<String, Object>> uploadAudioAsync(
            MultipartFile file, String traceId, String authorization) {
        return java.util.concurrent.CompletableFuture.supplyAsync(() -> {
            try {
                log.info("event=UPLOAD_TRANSCRIPT_STARTED traceId={} requestId={} source=upload", traceId, currentRequestId(traceId));
                Map<String, Object> result = uploadAudio(file, traceId, authorization);
                log.info("event=UPLOAD_TRANSCRIPT_COMPLETED traceId={} requestId={} source=upload", traceId, currentRequestId(traceId));
                return result;
            } catch (Exception e) {
                log.warn(
                        "event=UPLOAD_TRANSCRIPT_FAILED traceId={} requestId={} source=upload errorCode={}",
                        traceId,
                        currentRequestId(traceId),
                        e.getClass().getSimpleName()
                );
                throw new RuntimeException("Audio upload failed", e);
            }
        });
    }

    public ProcessingStatusResponse getProcessingStatus(Long meetingId, String traceId) {
        return getProcessingStatus(meetingId, traceId, null);
    }

    public ProcessingStatusResponse getProcessingStatus(Long meetingId, String traceId, String authorization) {
        try (MDC.MDCCloseable ignored = MDC.putCloseable("jobId", String.valueOf(meetingId))) {
            assertMeetingAccess(meetingId, traceId, authorization);
            Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
            if (state == null) {
                return new ProcessingStatusResponse(meetingId, "NOT_FOUND", 0, "unknown", null, null);
            }

            String status = normalizeStatus(state.get("status"));
            Integer progress = normalizeProgress(state.get("progress"));
            String stage = state.get("stage") == null ? "unknown" : String.valueOf(state.get("stage"));
            String error = state.get("error") == null ? null : String.valueOf(state.get("error"));
            String updatedAt = state.get("updatedAt") == null ? null : String.valueOf(state.get("updatedAt"));

            updateMetricsForState(meetingId, status, state);
            log.info("[traceId={}] [jobId={}] status read from redis={}", traceId, meetingId, status);

            return new ProcessingStatusResponse(meetingId, status, progress, stage, error, updatedAt);
        }
    }

    public Map<String, Object> getTranscript(Long meetingId, String traceId) {
        return getTranscript(meetingId, traceId, null);
    }

    public Map<String, Object> getTranscript(Long meetingId, String traceId, String authorization) {
        assertMeetingAccess(meetingId, traceId, authorization);
        log.info(
                "event=UPLOAD_TRANSCRIPT_STARTED traceId={} requestId={} meetingId={} source=upload",
                traceId,
                currentRequestId(traceId),
                meetingId
        );
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);

        String stateStatus = state == null ? "NOT_FOUND" : normalizeStatus(state.get("status"));
        List<Map<String, Object>> batchTranscripts = extractTranscriptRowsFromState(state);
        if (!batchTranscripts.isEmpty()) {
            log.info(
                    "event=UPLOAD_TRANSCRIPT_COMPLETED traceId={} requestId={} meetingId={} source=upload",
                    traceId,
                    currentRequestId(traceId),
                    meetingId
            );
            return Map.of(
                    "meeting_id", meetingId,
                    "status", stateStatus,
                    "transcripts", batchTranscripts
            );
        }

        log.info(
                "[traceId={}] [jobId={}] transcript job-state missing_or_empty status={} -> fallback to ai-service transcript",
                traceId,
                meetingId,
                stateStatus
        );

        List<Map<String, Object>> aiTranscripts = fetchTranscriptRowsFromAiService(meetingId, traceId);
        if (!aiTranscripts.isEmpty()) {
            String responseStatus = "NOT_FOUND".equals(stateStatus) ? "COMPLETED" : stateStatus;
            log.info(
                    "event=UPLOAD_TRANSCRIPT_COMPLETED traceId={} requestId={} meetingId={} source=upload",
                    traceId,
                    currentRequestId(traceId),
                    meetingId
            );
            return Map.of(
                    "meeting_id", meetingId,
                    "status", responseStatus,
                    "transcripts", aiTranscripts
            );
        }

        log.info(
                "[traceId={}] [jobId={}] transcript fallback empty/no transcript",
                traceId,
                meetingId
        );
        log.info(
                "event=UPLOAD_TRANSCRIPT_FAILED traceId={} requestId={} meetingId={} source=upload errorCode=TRANSCRIPT_NOT_READY",
                traceId,
                currentRequestId(traceId),
                meetingId
        );
        return Map.of(
                "meeting_id", meetingId,
                "status", stateStatus,
                "transcripts", List.of()
        );
    }

    public Map<String, Object> getAnalysis(Long meetingId, String traceId) {
        return getAnalysis(meetingId, traceId, null);
    }

    public Map<String, Object> getAnalysis(Long meetingId, String traceId, String authorization) {
        return getAnalysisInternal(meetingId, traceId, authorization, true);
    }

    public Map<String, Object> getAnalysisReadOnly(Long meetingId, String traceId, String authorization) {
        return getAnalysisInternal(meetingId, traceId, authorization, false);
    }

    private Map<String, Object> getAnalysisInternal(Long meetingId, String traceId, String authorization, boolean allowLazyTrigger) {
        assertMeetingAccess(meetingId, traceId, authorization);
        log.info(
                "event=ANALYSIS_GET_REQUEST traceId={} requestId={} meetingId={} source=analysis_get",
                traceId,
                currentRequestId(traceId),
                meetingId
        );
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        String stateStatus = state == null ? "NOT_FOUND" : normalizeStatus(state.get("status"));
        Map<String, Object> analysis = extractAnalysisFromState(state);
        JobStateStore.AnalysisStateSnapshot analysisState = jobStateStore.getAnalysisState(meetingId).orElse(null);
        if (!analysis.isEmpty()) {
            Map<String, Object> response = new HashMap<>();
            response.put("meeting_id", meetingId);
            response.put("status", stateStatus);
            response.putAll(analysis);
            log.info(
                    "event=ANALYSIS_GET_RESULT traceId={} requestId={} meetingId={} analysisStatus={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    stateStatus
            );
            return response;
        }

        log.info(
                "[traceId={}] [jobId={}] analysis job-state missing_or_empty status={} -> fallback to ai-service analysis",
                traceId,
                meetingId,
                stateStatus
        );

        Map<String, Object> aiAnalysis = fetchAnalysisFromAiService(meetingId, traceId);
        if (!aiAnalysis.isEmpty()) {
            Map<String, Object> response = new HashMap<>();
            response.put("meeting_id", meetingId);
            String aiStatus = normalizeStatus(aiAnalysis.get("status"));
            response.put("status", "NOT_FOUND".equals(stateStatus) ? aiStatus : stateStatus);
            for (Map.Entry<String, Object> entry : aiAnalysis.entrySet()) {
                if ("meeting_id".equals(entry.getKey()) || "status".equals(entry.getKey())) {
                    continue;
                }
                response.put(entry.getKey(), entry.getValue());
            }
            log.info(
                    "event=ANALYSIS_GET_RESULT traceId={} requestId={} meetingId={} analysisStatus={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    response.get("status")
            );
            return response;
        }

        if (!allowLazyTrigger) {
            Map<String, Object> response = new HashMap<>();
            response.put("meeting_id", meetingId);
            response.put("status", stateStatus);
            if (analysisState != null) {
                if (analysisState.retryAfterSeconds() > 0) {
                    response.put("retryAfterSeconds", analysisState.retryAfterSeconds());
                }
                if (analysisState.errorCode() != null && !analysisState.errorCode().isBlank()) {
                    response.put("errorCode", analysisState.errorCode());
                }
            }
            return response;
        }

        if (analysisState != null && analysisState.isFailed() && analysisState.retryAfterSeconds() > 0) {
            throw toAnalysisFailureException(analysisState.errorCode(), analysisState.retryAfterSeconds());
        }

        AnalysisTriggerResult triggerResult = maybeTriggerRealtimeAnalysisLazy(meetingId, traceId, authorization, state);
        if ("FAILED".equals(triggerResult.status()) && triggerResult.errorCode() != null && !triggerResult.errorCode().isBlank()) {
            throw toAnalysisFailureException(triggerResult.errorCode(), triggerResult.retryAfterSeconds());
        }

        log.info(
                "event=ANALYSIS_GET_NOT_READY traceId={} requestId={} meetingId={} analysisStatus={}",
                traceId,
                currentRequestId(traceId),
                meetingId,
                stateStatus
        );
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        response.put("status", stateStatus);
        if (analysisState != null && analysisState.retryAfterSeconds() > 0) {
            response.put("retryAfterSeconds", analysisState.retryAfterSeconds());
            if (analysisState.errorCode() != null && !analysisState.errorCode().isBlank()) {
                response.put("errorCode", analysisState.errorCode());
            }
        } else if (triggerResult.retryAfterSeconds() > 0) {
            response.put("retryAfterSeconds", triggerResult.retryAfterSeconds());
        }
        return response;
    }

    private String normalizeStatus(Object value) {
        if (value == null) {
            return "UNKNOWN";
        }
        String normalized = String.valueOf(value).trim().toUpperCase();
        if (normalized.equals("PENDING")) {
            return "QUEUED";
        }
        return normalized;
    }

    private Integer normalizeProgress(Object value) {
        if (value == null) {
            return 0;
        }
        try {
            int parsed = Integer.parseInt(String.valueOf(value));
            if (parsed < 0) {
                return 0;
            }
            if (parsed > 100) {
                return 100;
            }
            return parsed;
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private String resolveFileId(String fileId, String audioPath, Long meetingId) {
        if (fileId != null && !fileId.isBlank()) {
            return fileId;
        }
        if (audioPath != null && !audioPath.isBlank()) {
            return audioPath;
        }
        return "legacy-meeting:" + meetingId;
    }

    private String normalizeBatchLanguage(String language) {
        if (language == null) {
            return "vi";
        }
        String normalized = language.trim().toLowerCase();
        if (ALLOWED_UPLOAD_LANGUAGES.contains(normalized)) {
            return normalized;
        }
        return "vi";
    }

    private void syncMeetingStatusSafely(Long meetingId, String processingStatus, String traceId, String authorization) {
        if (meetingId == null || authorization == null || authorization.isBlank()) {
            return;
        }
        String meetingStatus = toMeetingStatus(processingStatus);
        try {
            meetingServiceClient.updateMeetingStatus(meetingId, meetingStatus, traceId, authorization);
        } catch (Exception ex) {
            log.warn(
                    "event=MEETING_STATUS_SYNC_FAILED traceId={} requestId={} meetingId={} status={} errorCode={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    meetingStatus,
                    ex.getClass().getSimpleName()
            );
        }
    }

    private String toMeetingStatus(String processingStatus) {
        String normalized = normalizeStatus(processingStatus);
        if ("COMPLETED".equals(normalized)) {
            return MEETING_STATUS_COMPLETED;
        }
        if ("FAILED".equals(normalized)) {
            return MEETING_STATUS_FAILED;
        }
        return MEETING_STATUS_PROCESSING;
    }

    private void assertMeetingAccess(Long meetingId, String traceId, String authorization) {
        if (authorization == null || authorization.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Missing authorization");
        }
        try {
            meetingServiceClient.getMeetingById(meetingId, traceId, authorization);
        } catch (HttpStatusCodeException ex) {
            int status = ex.getStatusCode().value();
            if (status == HttpStatus.FORBIDDEN.value()) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Forbidden");
            }
            if (status == HttpStatus.NOT_FOUND.value()) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Meeting not found");
            }
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Meeting service error");
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> extractResult(Map<String, Object> state) {
        if (state == null) {
            return Map.of();
        }
        Object result = state.get("result");
        if (result instanceof Map<?, ?> resultMap) {
            Map<String, Object> value = new HashMap<>();
            for (Map.Entry<?, ?> entry : resultMap.entrySet()) {
                value.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            return value;
        }
        return Map.of();
    }

    private Map<String, Object> extractAnalysisFromState(Map<String, Object> state) {
        Map<String, Object> result = extractResult(state);
        Map<String, Object> analysis = new HashMap<>();
        Object analysisObj = result.get("analysis");
        if (analysisObj instanceof Map<?, ?> mapObj) {
            for (Map.Entry<?, ?> entry : mapObj.entrySet()) {
                analysis.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }
        return analysis;
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> extractTranscriptRowsFromState(Map<String, Object> state) {
        if (state == null) {
            return List.of();
        }
        Map<String, Object> result = extractResult(state);
        Object transcripts = result.get("transcripts");
        return normalizeTranscriptRows(transcripts);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> normalizeTranscriptRows(Object transcripts) {
        if (!(transcripts instanceof List<?> list) || list.isEmpty()) {
            return List.of();
        }

        List<Map<String, Object>> rows = new ArrayList<>();
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> mapItem)) {
                continue;
            }
            Map<String, Object> normalized = new HashMap<>();
            for (Map.Entry<?, ?> entry : mapItem.entrySet()) {
                normalized.put(String.valueOf(entry.getKey()), entry.getValue());
            }
            rows.add(normalized);
        }
        return rows;
    }

    private List<Map<String, Object>> fetchTranscriptRowsFromAiService(Long meetingId, String traceId) {
        try {
            Map<String, Object> aiResponse = aiServiceClient.getTranscript(meetingId, traceId);
            List<Map<String, Object>> rows = normalizeTranscriptRows(aiResponse.get("transcripts"));
            log.info(
                    "[traceId={}] [jobId={}] ai-service transcript fallback rows={}",
                    traceId,
                    meetingId,
                    rows.size()
            );
            return rows;
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                log.info(
                        "[traceId={}] [jobId={}] ai-service transcript fallback returned 404/no transcript",
                        traceId,
                        meetingId
                );
                return List.of();
            }
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=transcript_fallback httpStatus={} errorCode=DOWNSTREAM_HTTP_ERROR",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getStatusCode().value()
            );
            return List.of();
        } catch (Exception ex) {
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=transcript_fallback errorCode={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getClass().getSimpleName()
            );
            return List.of();
        }
    }

    private Map<String, Object> fetchAnalysisFromAiService(Long meetingId, String traceId) {
        try {
            Map<String, Object> aiResponse = aiServiceClient.getAnalysis(meetingId, traceId);
            if (aiResponse != null && !aiResponse.isEmpty()) {
                log.info(
                        "[traceId={}] [jobId={}] ai-service analysis fallback keys={}",
                        traceId,
                        meetingId,
                        aiResponse.keySet()
                );
                return aiResponse;
            }
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                log.info(
                        "[traceId={}] [jobId={}] ai-service analysis fallback returned 404/not_found",
                        traceId,
                        meetingId
                );
                return Map.of();
            }
            if (ex.getStatusCode().value() == HttpStatus.SERVICE_UNAVAILABLE.value()) {
                throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Gemini service unavailable");
            }
            if (ex.getStatusCode().value() == HttpStatus.BAD_GATEWAY.value()) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Gemini analysis failed");
            }
            if (ex.getStatusCode().value() == HttpStatus.UNPROCESSABLE_ENTITY.value()) {
                throw new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Empty transcript");
            }
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=analysis_fallback httpStatus={} errorCode=DOWNSTREAM_HTTP_ERROR",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getStatusCode().value()
            );
            return Map.of();
        } catch (Exception ex) {
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=analysis_fallback errorCode={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getClass().getSimpleName()
            );
            return Map.of();
        }
        return Map.of();
    }

    private AnalysisTriggerResult maybeTriggerRealtimeAnalysisLazy(
            Long meetingId,
            String traceId,
            String authorization,
            Map<String, Object> state
    ) {
        final String source = REALTIME_ANALYSIS_SOURCE_GET_ANALYSIS_LAZY;
        log.info(
                "event=ANALYSIS_TRIGGER_REQUEST meetingId={} source={} traceId={} requestId={}",
                meetingId,
                source,
                traceId,
                currentRequestId(traceId)
        );

        List<Map<String, Object>> transcriptRows = extractTranscriptRowsFromState(state);
        if (transcriptRows.isEmpty()) {
            transcriptRows = fetchTranscriptRowsFromAiService(meetingId, traceId);
        }

        String transcriptText = buildTranscriptText(transcriptRows);
        if (transcriptText.isBlank()) {
            String reason = transcriptRows.isEmpty() ? "transcript_not_ready" : "empty_transcript";
            logRealtimeAnalysisSkipThrottled(meetingId, source, reason);
            if ("empty_transcript".equals(reason)) {
                return new AnalysisTriggerResult("FAILED", "EMPTY_TRANSCRIPT", 0);
            }
            return new AnalysisTriggerResult("NOT_READY", null, 0);
        }

        String transcriptHash = computeTranscriptHash(transcriptText);
        String promptVersion = resolvePromptVersion(null);
        String schemaVersion = resolveSchemaVersion(null);
        String analysisCacheKey = buildAnalysisCacheKey(transcriptHash, promptVersion, schemaVersion);
        JobStateStore.AnalysisTriggerDecision decision = jobStateStore.tryStartAnalysis(
                meetingId,
                analysisCacheKey,
                source,
                "processing_service_lazy_poll"
        );
        if (!decision.shouldTrigger()) {
            log.info(
                    "event=ANALYSIS_TRIGGER_SKIPPED meetingId={} source={} reason={} retryAfterSeconds={}",
                    meetingId,
                    source,
                    decision.reason(),
                    decision.retryAfterSeconds()
            );
            logRealtimeAnalysisSkipThrottled(meetingId, source, decision.reason());
            if ("cooldown_active".equals(decision.reason())) {
                return new AnalysisTriggerResult("FAILED", decision.errorCode(), decision.retryAfterSeconds());
            }
            return new AnalysisTriggerResult(decision.status(), null, decision.retryAfterSeconds());
        }

        try {
            String finalTranscriptText = transcriptText;
            String lockToken = decision.lockToken();
            CompletableFuture.runAsync(() -> runLazyRealtimeAnalysis(
                    meetingId,
                    finalTranscriptText,
                    transcriptHash,
                    analysisCacheKey,
                    traceId,
                    authorization,
                    source,
                    lockToken
            ));
            log.info("event=REALTIME_ANALYSIS_TRIGGERED meetingId={} source={}", meetingId, source);
            return new AnalysisTriggerResult("RUNNING", null, 0);
        } catch (Exception ex) {
            String errorCode = mapAnalysisFailureCode(ex);
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    analysisCacheKey,
                    source,
                    "processing_service_lazy_poll",
                    decision.lockToken(),
                    errorCode,
                    ex.getClass().getSimpleName()
            );
            log.warn(
                    "event=ANALYSIS_TRIGGER_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    source,
                    errorCode
            );
            return new AnalysisTriggerResult("FAILED", errorCode, 0);
        }
    }

    private void runLazyRealtimeAnalysis(
            Long meetingId,
            String transcriptText,
            String transcriptHash,
            String analysisCacheKey,
            String traceId,
            String authorization,
            String source,
            String lockToken
    ) {
        try {
            String promptVersion = resolvePromptVersion(null);
            String schemaVersion = resolveSchemaVersion(null);
            Map<String, Object> response = aiServiceClient.analyzeRealtimeTranscript(
                    meetingId,
                    transcriptText,
                    "it",
                    "realtime",
                    transcriptHash,
                    promptVersion,
                    schemaVersion,
                    traceId,
                    authorization
            );
            String responsePromptVersion = resolvePromptVersion(response);
            String responseSchemaVersion = resolveSchemaVersion(response);
            String responseCacheKey = buildAnalysisCacheKey(
                    transcriptHash,
                    responsePromptVersion,
                    responseSchemaVersion
            );
            String status = normalizeStatus(response == null ? null : response.get("status"));
            String reason = normalizeRealtimeSkipReason(response);
            int retryAfter = parseRetryAfter(response);
            if ("FAILED".equals(status)) {
                String errorCode = mapRealtimeFailureCode(response);
                jobStateStore.markAnalysisFailed(
                        meetingId,
                        responseCacheKey,
                        source,
                        "processing_service_lazy_poll",
                        lockToken,
                        errorCode,
                        safeErrorText(response.get("reason"))
                );
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode={} retryAfterSeconds={}",
                        meetingId,
                        source,
                        errorCode,
                        retryAfter
                );
                return;
            }

            if ("COMPLETED".equals(status)) {
                jobStateStore.markAnalysisCompleted(
                        meetingId,
                        responseCacheKey,
                        source,
                        "processing_service_lazy_poll",
                        lockToken
                );
                log.info("event=REALTIME_ANALYSIS_SAVED meetingId={} source={}", meetingId, source);
                return;
            }

            if ("SKIPPED".equals(status)) {
                if ("already_exists".equals(reason) && hasPersistedAnalysisResult(meetingId, traceId)) {
                    jobStateStore.markAnalysisCompleted(
                            meetingId,
                            responseCacheKey,
                            source,
                            "processing_service_lazy_poll",
                            lockToken
                    );
                    log.info(
                            "event=REALTIME_ANALYSIS_SAVED meetingId={} source={} reason=already_exists_verified",
                            meetingId,
                            source
                    );
                    return;
                }

                jobStateStore.markAnalysisSkipped(
                        meetingId,
                        responseCacheKey,
                        source,
                        "processing_service_lazy_poll",
                        lockToken,
                        reason.isBlank() ? "skipped" : reason,
                        retryAfter
                );
                log.info(
                        "event=REALTIME_ANALYSIS_SKIPPED reason={} source={} meetingId={} retryAfterSeconds={}",
                        reason.isBlank() ? "skipped" : reason,
                        source,
                        meetingId,
                        retryAfter
                );
                return;
            }

            jobStateStore.markAnalysisSkipped(
                    meetingId,
                    responseCacheKey,
                    source,
                    "processing_service_lazy_poll",
                    lockToken,
                    "unexpected_status",
                    retryAfter
            );
            log.warn(
                    "event=REALTIME_ANALYSIS_SKIPPED reason=unexpected_status source={} meetingId={} status={} retryAfterSeconds={}",
                    source,
                    meetingId,
                    status,
                    retryAfter
            );
        } catch (HttpStatusCodeException ex) {
            String errorCode = mapAnalysisFailureCode(ex);
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    analysisCacheKey,
                    source,
                    "processing_service_lazy_poll",
                    lockToken,
                    errorCode,
                    safeErrorText(ex.getStatusText())
            );
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode={} httpStatus={}",
                    meetingId,
                    source,
                    errorCode,
                    ex.getStatusCode().value()
            );
        } catch (Exception ex) {
            String errorCode = mapAnalysisFailureCode(ex);
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    analysisCacheKey,
                    source,
                    "processing_service_lazy_poll",
                    lockToken,
                    errorCode,
                    ex.getClass().getSimpleName()
            );
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    source,
                    errorCode
            );
        }
    }

    private String buildTranscriptText(List<Map<String, Object>> rows) {
        if (rows == null || rows.isEmpty()) {
            return "";
        }
        StringBuilder builder = new StringBuilder();
        for (Map<String, Object> row : rows) {
            String speaker = row.get("speaker") == null ? "" : String.valueOf(row.get("speaker")).trim();
            String text = row.get("text") == null ? "" : String.valueOf(row.get("text")).trim();
            if (text.isBlank()) {
                continue;
            }
            if (!speaker.isBlank()) {
                builder.append(speaker).append(": ");
            }
            builder.append(text).append('\n');
        }
        return builder.toString().trim();
    }

    private String computeTranscriptHash(String transcriptText) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(transcriptText.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(bytes);
        } catch (NoSuchAlgorithmException ex) {
            return Integer.toHexString(transcriptText.hashCode());
        }
    }

    private String resolvePromptVersion(Map<String, Object> response) {
        if (response != null) {
            Object value = response.get("promptVersion");
            if (value != null && !String.valueOf(value).trim().isBlank()) {
                return String.valueOf(value).trim();
            }
            Object snake = response.get("prompt_version");
            if (snake != null && !String.valueOf(snake).trim().isBlank()) {
                return String.valueOf(snake).trim();
            }
        }
        String fallback = analysisPromptVersion == null ? "" : analysisPromptVersion.trim();
        return fallback.isBlank() ? "gemini-business-v1" : fallback;
    }

    private String resolveSchemaVersion(Map<String, Object> response) {
        if (response != null) {
            Object value = response.get("schemaVersion");
            if (value != null && !String.valueOf(value).trim().isBlank()) {
                return String.valueOf(value).trim();
            }
            Object snake = response.get("schema_version");
            if (snake != null && !String.valueOf(snake).trim().isBlank()) {
                return String.valueOf(snake).trim();
            }
        }
        String fallback = analysisSchemaVersion == null ? "" : analysisSchemaVersion.trim();
        return fallback.isBlank() ? "gemini-business-v1" : fallback;
    }

    private String buildAnalysisCacheKey(String transcriptHash, String promptVersion, String schemaVersion) {
        String normalizedHash = transcriptHash == null ? "" : transcriptHash.trim().toLowerCase(Locale.ROOT);
        String normalizedPromptVersion = promptVersion == null ? "" : promptVersion.trim().toLowerCase(Locale.ROOT);
        String normalizedSchemaVersion = schemaVersion == null ? "" : schemaVersion.trim().toLowerCase(Locale.ROOT);
        return normalizedHash + "|" + normalizedPromptVersion + "|" + normalizedSchemaVersion;
    }

    private void logRealtimeAnalysisSkipThrottled(Long meetingId, String source, String reason) {
        if (!jobStateStore.shouldLogAnalysisSkip(meetingId, source, reason)) {
            return;
        }
        log.info(
                "event=REALTIME_ANALYSIS_SKIPPED reason={} source={} meetingId={}",
                reason,
                source,
                meetingId
        );
    }

    private String mapRealtimeFailureCode(Map<String, Object> response) {
        if (response == null) {
            return "GEMINI_ANALYSIS_FAILED";
        }
        Object reason = response.get("reason");
        String normalized = reason == null ? "" : String.valueOf(reason).trim().toLowerCase();
        if (normalized.contains("empty_transcript")) {
            return "EMPTY_TRANSCRIPT";
        }
        if (normalized.contains("unavailable")) {
            return "GEMINI_UNAVAILABLE";
        }
        return "GEMINI_ANALYSIS_FAILED";
    }

    private String normalizeRealtimeSkipReason(Map<String, Object> response) {
        if (response == null) {
            return "";
        }
        return safeErrorText(response.get("reason")).trim().toLowerCase(Locale.ROOT);
    }

    private boolean hasPersistedAnalysisResult(Long meetingId, String traceId) {
        try {
            Map<String, Object> response = aiServiceClient.getAnalysis(meetingId, traceId);
            return hasStructuredAnalysis(response);
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                return false;
            }
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=analysis_verify httpStatus={} errorCode=DOWNSTREAM_HTTP_ERROR",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getStatusCode().value()
            );
            return false;
        } catch (Exception ex) {
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=analysis_verify errorCode={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getClass().getSimpleName()
            );
            return false;
        }
    }

    private boolean hasStructuredAnalysis(Map<String, Object> payload) {
        if (payload == null || payload.isEmpty()) {
            return false;
        }
        String summary = safeErrorText(payload.get("summary"));
        if (!summary.isBlank()) {
            return true;
        }
        if (payload.get("analysis") instanceof Map<?, ?> analysisMap) {
            Object nestedSummary = analysisMap.get("summary");
            if (nestedSummary != null && !String.valueOf(nestedSummary).trim().isBlank()) {
                return true;
            }
        }
        return (payload.get("keywords") instanceof List<?> keywords && !keywords.isEmpty())
                || (payload.get("technicalTerms") instanceof List<?> technicalTerms && !technicalTerms.isEmpty())
                || (payload.get("painPoints") instanceof List<?> painPoints && !painPoints.isEmpty())
                || (payload.get("actionItems") instanceof List<?> actionItems && !actionItems.isEmpty())
                || (payload.get("businessActionItems") instanceof List<?> businessActionItems && !businessActionItems.isEmpty())
                || (payload.get("keyDecisions") instanceof List<?> keyDecisions && !keyDecisions.isEmpty())
                || (payload.get("risks") instanceof List<?> risks && !risks.isEmpty())
                || (payload.get("blockers") instanceof List<?> blockers && !blockers.isEmpty())
                || (payload.get("nextSteps") instanceof List<?> nextSteps && !nextSteps.isEmpty())
                || (payload.get("technical_terms") instanceof List<?> technicalTermsSnake && !technicalTermsSnake.isEmpty())
                || (payload.get("action_items") instanceof List<?> actionItemsSnake && !actionItemsSnake.isEmpty());
    }

    private int parseRetryAfter(Map<String, Object> response) {
        if (response == null) {
            return 0;
        }
        Object value = response.get("retryAfterSeconds");
        if (value == null) {
            return 0;
        }
        try {
            return Math.max(0, Integer.parseInt(String.valueOf(value)));
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private String mapAnalysisFailureCode(Exception ex) {
        if (ex instanceof HttpStatusCodeException httpError) {
            int status = httpError.getStatusCode().value();
            String body = safeErrorText(httpError.getResponseBodyAsString()).toLowerCase();
            String message = safeErrorText(httpError.getStatusText()).toLowerCase();
            if (status == 422 || body.contains("empty_transcript") || message.contains("empty transcript")) {
                return "EMPTY_TRANSCRIPT";
            }
            if (status == 503 || body.contains("gemini_unavailable") || message.contains("gemini")) {
                return "GEMINI_UNAVAILABLE";
            }
            if (status == 502) {
                return "GEMINI_ANALYSIS_FAILED";
            }
            return "AI_SERVICE_UNAVAILABLE";
        }
        return "GEMINI_ANALYSIS_FAILED";
    }

    private ResponseStatusException toAnalysisFailureException(String errorCode, int retryAfterSeconds) {
        String suffix = retryAfterSeconds > 0 ? " retryAfterSeconds=" + retryAfterSeconds : "";
        if ("EMPTY_TRANSCRIPT".equals(errorCode)) {
            return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Empty transcript" + suffix);
        }
        if ("GEMINI_UNAVAILABLE".equals(errorCode)) {
            return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Gemini service unavailable" + suffix);
        }
        if ("AI_SERVICE_UNAVAILABLE".equals(errorCode)) {
            return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "AI service unavailable" + suffix);
        }
        return new ResponseStatusException(HttpStatus.BAD_GATEWAY, "Gemini analysis failed" + suffix);
    }

    private String safeErrorText(Object value) {
        if (value == null) {
            return "";
        }
        String text = String.valueOf(value).trim();
        if (text.length() <= 180) {
            return text;
        }
        return text.substring(0, 180);
    }

    private record AnalysisTriggerResult(String status, String errorCode, int retryAfterSeconds) {
    }

    private void updateMetricsForState(Long meetingId, String status, Map<String, Object> state) {
        if ("RUNNING".equals(status)) {
            activeJobs.add(meetingId);
            runningGauge.set(activeJobs.size());
            return;
        }

        activeJobs.remove(meetingId);
        runningGauge.set(activeJobs.size());

        if ("COMPLETED".equals(status)) {
            recordDuration(state);
        }
    }

    private void incrementJobsTotal(String status) {
        Counter.builder("jobs_total")
                .tag("status", status)
                .register(meterRegistry)
                .increment();
    }

    private void recordDuration(Map<String, Object> state) {
        String createdAt = state.get("createdAt") == null ? null : String.valueOf(state.get("createdAt"));
        String updatedAt = state.get("updatedAt") == null ? null : String.valueOf(state.get("updatedAt"));
        if (createdAt == null || updatedAt == null) {
            return;
        }
        try {
            Duration duration = Duration.between(Instant.parse(createdAt), Instant.parse(updatedAt));
            if (!duration.isNegative()) {
                Timer.builder("job_duration_seconds").register(meterRegistry).record(duration);
            }
        } catch (DateTimeParseException ignored) {
            log.debug("Unable to parse job duration timestamps createdAt={} updatedAt={}", createdAt, updatedAt);
        }
    }

    private String currentRequestId(String fallbackTraceId) {
        String requestId = MDC.get("requestId");
        if (requestId != null && !requestId.isBlank()) {
            return requestId;
        }
        if (fallbackTraceId != null && !fallbackTraceId.isBlank()) {
            return fallbackTraceId;
        }
        String traceIdFromMdc = MDC.get("traceId");
        return traceIdFromMdc == null ? "" : traceIdFromMdc;
    }
}
