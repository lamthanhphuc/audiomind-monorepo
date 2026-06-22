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
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.client.HttpStatusCodeException;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.client.AIServiceClient;
import com.example.processingservice.client.MeetingServiceClient;
import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;
import com.example.processingservice.controller.dto.TranscriptSearchResponse;
import com.example.processingservice.controller.dto.ProcessStartResponse;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import com.example.processingservice.service.report.MeetingActionPlanBuilder;
import com.example.processingservice.service.report.MeetingActionPlanData;
import com.example.processingservice.service.report.MeetingActionPlanDocxGenerator;
import com.example.processingservice.service.report.MeetingReportData;
import com.example.processingservice.service.report.MeetingReportDocxGenerator;

import io.micrometer.core.instrument.Counter;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import jakarta.annotation.PostConstruct;

@Service
public class ProcessingService {
    private static final Set<String> ALLOWED_UPLOAD_LANGUAGES = Set.of("vi", "en", "multi");
    private static final String CANONICAL_ANALYSIS_VERSION = "gemini-business-v2";
    private static final String GROUPED_ACTION_PLAN_FEATURE_SET = "grouped-action-plan-v1";
    private static final String REALTIME_ANALYSIS_SOURCE_GET_ANALYSIS_LAZY = "get_analysis_lazy";
    private static final String MEETING_STATUS_PROCESSING = "processing";
    private static final String MEETING_STATUS_COMPLETED = "completed";
    private static final String MEETING_STATUS_FAILED = "failed";
    private static final int MAX_REPORT_HIGHLIGHT_ROWS = 50;
    private static final double READABLE_DUPLICATE_WINDOW_SECONDS = 20d;
    private static final int READABLE_TINY_FRAGMENT_MAX_WORDS = 3;
    private static final int READABLE_COLLAPSIBLE_FRAGMENT_MAX_WORDS = 18;
    private static final double APPENDIX_NEAR_WINDOW_SECONDS = 90d;
    private static final double APPENDIX_COVERAGE_THRESHOLD = 0.85d;
    private static final int APPENDIX_SHORT_FRAGMENT_MAX_CHARS = 40;
    private static final double APPENDIX_MAX_BLOCK_SECONDS = 45d;
    private static final int APPENDIX_MAX_BLOCK_CHARS = 700;
    private static final double APPENDIX_MERGE_GAP_SECONDS = 3d;
    private static final double APPENDIX_NEAR_DUPLICATE_WINDOW_SECONDS = APPENDIX_NEAR_WINDOW_SECONDS;
    private static final int APPENDIX_SHORT_FRAGMENT_MAX_NORMALIZED_LEN = APPENDIX_SHORT_FRAGMENT_MAX_CHARS;
    private static final String TRANSCRIPT_MODE_RAW = "raw";
    private static final String TRANSCRIPT_MODE_CANONICAL = "canonical";
    private static final String ANALYSIS_STATUS_NO_ANALYSIS = "NO_ANALYSIS";
    private static final String ANALYSIS_STATUS_STALE = "STALE";
    private static final String NO_TRANSCRIPT_AFTER_FINALIZE = "NO_TRANSCRIPT_AFTER_FINALIZE";
    private static final String COMPLETED_WITH_NO_SPEECH_DETECTED = "COMPLETED_WITH_NO_SPEECH_DETECTED";
    private static final String READABLE_TRANSCRIPT_EXPORT_NOTE =
            "Readable transcript export is generated from saved STT output and canonical transcript data when available.";
    private static final String DEFAULT_SPEAKER_STABILIZATION_VERSION = "speaker-stabilization-v1";
    private static final Pattern RETRY_AFTER_SECONDS_PATTERN =
            Pattern.compile("\"retryAfterSeconds\"\\s*:\\s*\"?(\\d+)\"?");

    private static final Logger log = LoggerFactory.getLogger(ProcessingService.class);

    private final AIServiceClient aiServiceClient;
    private final MeetingServiceClient meetingServiceClient;
    private final JobStateStore jobStateStore;
    private final MeterRegistry meterRegistry;
    private final MeetingReportDocxGenerator meetingReportDocxGenerator;
    private final TranscriptEvidenceSearchService transcriptEvidenceSearchService;
    private final MeetingActionPlanBuilder meetingActionPlanBuilder;
    private final MeetingActionPlanDocxGenerator meetingActionPlanDocxGenerator;
    @Value("${processing.analysis.prompt-version:gemini-business-v2}")
    private String analysisPromptVersion;
    @Value("${processing.analysis.schema-version:gemini-business-v2}")
    private String analysisSchemaVersion;
    @Value("${speaker.stabilization.enabled:true}")
    private boolean speakerStabilizationEnabled = true;
    @Value("${speaker.stabilization.version:" + DEFAULT_SPEAKER_STABILIZATION_VERSION + "}")
    private String speakerStabilizationVersion = DEFAULT_SPEAKER_STABILIZATION_VERSION;
    @Value("${speaker.stabilization.min-segment-seconds:1.2}")
    private double speakerMinSegmentSeconds = 1.2d;
    @Value("${speaker.stabilization.max-gap-seconds:1.0}")
    private double speakerMaxGapSeconds = 1.0d;
    @Value("${speaker.stabilization.island-max-seconds:2.0}")
    private double speakerIslandMaxSeconds = 2.0d;
    @Value("${speaker.stabilization.max-merged-turn-seconds:20.0}")
    private double speakerMaxMergedTurnSeconds = 20.0d;
    @Value("${speaker.stabilization.max-reasonable-count:8}")
    private int speakerMaxReasonableCount = 8;
    @Value("${speaker.stabilization.dry-run:false}")
    private boolean speakerStabilizationDryRun = false;
    @Value("${speaker.stabilization.log-stats:true}")
    private boolean speakerStabilizationLogStats = true;

    private final AtomicInteger runningGauge = new AtomicInteger(0);
    private final Set<Long> activeJobs = Collections.newSetFromMap(new ConcurrentHashMap<>());

    ProcessingService(
            AIServiceClient aiServiceClient,
            MeetingServiceClient meetingServiceClient,
            JobStateStore jobStateStore,
            MeterRegistry meterRegistry,
            MeetingReportDocxGenerator meetingReportDocxGenerator
    ) {
        this(
                aiServiceClient,
                meetingServiceClient,
                jobStateStore,
                meterRegistry,
                meetingReportDocxGenerator,
                new TranscriptEvidenceSearchService(),
                new MeetingActionPlanBuilder(),
                new MeetingActionPlanDocxGenerator()
        );
    }

    @Autowired
    public ProcessingService(
            AIServiceClient aiServiceClient,
            MeetingServiceClient meetingServiceClient,
            JobStateStore jobStateStore,
            MeterRegistry meterRegistry,
            MeetingReportDocxGenerator meetingReportDocxGenerator,
            TranscriptEvidenceSearchService transcriptEvidenceSearchService,
            MeetingActionPlanBuilder meetingActionPlanBuilder,
            MeetingActionPlanDocxGenerator meetingActionPlanDocxGenerator
    ) {
        this.aiServiceClient = aiServiceClient;
        this.meetingServiceClient = meetingServiceClient;
        this.jobStateStore = jobStateStore;
        this.meterRegistry = meterRegistry;
        this.meetingReportDocxGenerator = meetingReportDocxGenerator;
        this.transcriptEvidenceSearchService = transcriptEvidenceSearchService;
        this.meetingActionPlanBuilder = meetingActionPlanBuilder;
        this.meetingActionPlanDocxGenerator = meetingActionPlanDocxGenerator;
    }

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

    @Autowired
    private UploadValidator uploadValidator;

    public Map<String, Object> uploadAudio(MultipartFile file, String traceId, String authorization) {
        log.info(
                "event=UPLOAD_REQUEST_RECEIVED traceId={} requestId={} source=upload path=/processing/upload",
                traceId,
                currentRequestId(traceId)
        );
        uploadValidator.validateIfStrict(file, file == null ? null : file.getOriginalFilename());
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

    private static final String REALTIME_FINAL_AUDIO_FALLBACK_SOURCE = "final_audio_fallback";

    public Map<String, Object> runRealtimeFinalAudioFallback(
            Long meetingId,
            MultipartFile file,
            String language,
            String traceId,
            String authorization) {
        assertMeetingAccess(meetingId, traceId, authorization);
        String resolvedTraceId = traceId == null || traceId.isBlank()
                ? "realtime-final-audio-fallback-" + meetingId
                : traceId;
        log.info(
                "event=REALTIME_FINAL_AUDIO_FALLBACK_REQUESTED traceId={} requestId={} meetingId={} source={}",
                resolvedTraceId,
                currentRequestId(resolvedTraceId),
                meetingId,
                REALTIME_FINAL_AUDIO_FALLBACK_SOURCE
        );

        if (file == null || file.isEmpty()) {
            log.warn(
                    "event=REALTIME_FINAL_AUDIO_FALLBACK_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                    RealtimeStatusCodes.FINAL_AUDIO_FALLBACK_UNAVAILABLE
            );
            return buildFinalAudioFallbackResponse(
                    meetingId,
                    RealtimeStatusCodes.FINAL_AUDIO_FALLBACK_UNAVAILABLE,
                    0,
                    false
            );
        }

        Map<String, Object> uploadResult;
        try {
            uploadResult = uploadAudio(file, resolvedTraceId, authorization);
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_FINAL_AUDIO_FALLBACK_FAILED meetingId={} source={} errorCode=UPLOAD_FAILED error={}",
                    meetingId,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                    ex.getClass().getSimpleName()
            );
            return buildFinalAudioFallbackResponse(
                    meetingId,
                    "UPLOAD_FAILED",
                    0,
                    false
            );
        }

        String audioPath = uploadResult.get("audio_path") == null
                ? null
                : String.valueOf(uploadResult.get("audio_path"));
        if (audioPath == null || audioPath.isBlank()) {
            return buildFinalAudioFallbackResponse(
                    meetingId,
                    RealtimeStatusCodes.FINAL_AUDIO_FALLBACK_UNAVAILABLE,
                    0,
                    false
            );
        }

        Map<String, Object> fallbackResult;
        try {
            fallbackResult = aiServiceClient.runFinalAudioFallback(
                    meetingId,
                    audioPath,
                    language,
                    resolvedTraceId,
                    authorization
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_FINAL_AUDIO_FALLBACK_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                    ex.getClass().getSimpleName()
            );
            return buildFinalAudioFallbackResponse(
                    meetingId,
                    "STT_FINAL_AUDIO_FALLBACK_FAILED",
                    0,
                    false
            );
        }

        int transcriptCount = parseTranscriptCount(fallbackResult.get("transcript_count"));
        boolean idempotentReplay = Boolean.TRUE.equals(fallbackResult.get("idempotent_replay"));
        String errorCode = fallbackResult.get("error_code") == null
                ? null
                : String.valueOf(fallbackResult.get("error_code"));
        String fallbackStatus = fallbackResult.get("status") == null
                ? ""
                : String.valueOf(fallbackResult.get("status"));

        if (!"completed".equalsIgnoreCase(fallbackStatus)) {
            String terminalCode = errorCode == null || errorCode.isBlank()
                    ? "STT_FINAL_AUDIO_FALLBACK_FAILED"
                    : errorCode;
            persistRealtimeFinalAudioFallbackTerminal(meetingId, resolvedTraceId, terminalCode, transcriptCount);
            syncRealtimeTerminalMeetingStatus(meetingId, resolvedTraceId, authorization, terminalCode);
            return buildFinalAudioFallbackResponse(meetingId, terminalCode, transcriptCount, idempotentReplay);
        }

        if (transcriptCount <= 0) {
            String terminalCode = errorCode == null || errorCode.isBlank()
                    ? RealtimeStatusCodes.NO_TRANSCRIPT
                    : errorCode;
            persistRealtimeFinalAudioFallbackTerminal(meetingId, resolvedTraceId, terminalCode, 0);
            syncRealtimeTerminalMeetingStatus(meetingId, resolvedTraceId, authorization, terminalCode);
            log.info(
                    "event=REALTIME_FINAL_AUDIO_FALLBACK_STATUS meetingId={} source={} status={} transcriptRows=0",
                    meetingId,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                    terminalCode
            );
            return buildFinalAudioFallbackResponse(meetingId, terminalCode, 0, idempotentReplay);
        }

        try {
            jobStateStore.upsertJobState(
                    meetingId,
                    RealtimeStatusCodes.COMPLETED,
                    "realtime-meeting:" + meetingId,
                    Map.of(
                            "transcriptRows", transcriptCount,
                            "finalized", true,
                            "fallbackSource", REALTIME_FINAL_AUDIO_FALLBACK_SOURCE
                    ),
                    null,
                    resolvedTraceId
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_FINAL_AUDIO_FALLBACK_STATE_PERSIST_FAILED meetingId={} source={} errorCode={}",
                    meetingId,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                    ex.getClass().getSimpleName()
            );
        }

        syncRealtimeTerminalMeetingStatus(
                meetingId,
                resolvedTraceId,
                authorization,
                RealtimeStatusCodes.COMPLETED
        );
        log.info(
                "event=REALTIME_FINAL_AUDIO_FALLBACK_STATUS meetingId={} source={} status={} transcriptRows={} idempotentReplay={}",
                meetingId,
                REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                RealtimeStatusCodes.COMPLETED,
                transcriptCount,
                idempotentReplay
        );

        Map<String, Object> analysisKickoff = getAnalysis(meetingId, resolvedTraceId, authorization);
        Map<String, Object> response = buildFinalAudioFallbackResponse(
                meetingId,
                RealtimeStatusCodes.COMPLETED,
                transcriptCount,
                idempotentReplay
        );
        response.put("analysis", analysisKickoff);
        return response;
    }

    private Map<String, Object> buildFinalAudioFallbackResponse(
            Long meetingId,
            String statusCode,
            int transcriptCount,
            boolean idempotentReplay) {
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        response.put("status", statusCode);
        response.put("errorCode", statusCode);
        response.put("transcript_count", transcriptCount);
        response.put("transcriptRows", transcriptCount);
        response.put("idempotent_replay", idempotentReplay);
        response.put("finalized", true);
        if (RealtimeStatusCodes.isNoTranscriptTerminal(statusCode)) {
            response.put("legacyErrorCode", RealtimeStatusCodes.legacyNoTranscriptAlias());
            response.put("analysisStatus", "NO_ANALYSIS");
        }
        return response;
    }

    private int parseTranscriptCount(Object value) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        if (value == null) {
            return 0;
        }
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private void persistRealtimeFinalAudioFallbackTerminal(
            Long meetingId,
            String traceId,
            String statusCode,
            int transcriptRows) {
        Map<String, Object> result = new HashMap<>();
        result.put("transcripts", List.of());
        result.put("analysisStatus", "NO_ANALYSIS");
        result.put("transcriptRows", transcriptRows);
        result.put("finalized", true);
        result.put("terminalStatus", statusCode);
        String persistedStatus = RealtimeStatusCodes.isNoTranscriptTerminal(statusCode)
                ? RealtimeStatusCodes.legacyNoTranscriptAlias()
                : statusCode;
        try {
            jobStateStore.upsertJobState(
                    meetingId,
                    persistedStatus,
                    "realtime-meeting:" + meetingId,
                    result,
                    null,
                    traceId
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_FINAL_AUDIO_FALLBACK_STATE_PERSIST_FAILED meetingId={} status={} errorCode={}",
                    meetingId,
                    statusCode,
                    ex.getClass().getSimpleName()
            );
        }
    }

    private void syncRealtimeTerminalMeetingStatus(
            Long meetingId,
            String traceId,
            String authorization,
            String terminalStatus) {
        if (meetingId == null || authorization == null || authorization.isBlank()) {
            return;
        }
        String meetingStatus = RealtimeStatusCodes.resolveMeetingStatusForTerminalOutcome(terminalStatus);
        try {
            meetingServiceClient.updateMeetingStatus(meetingId, meetingStatus, traceId, authorization);
            log.info(
                    "event=REALTIME_MEETING_STATUS_SYNCED meetingId={} meetingStatus={} terminalStatus={} source={}",
                    meetingId,
                    meetingStatus,
                    terminalStatus,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REALTIME_MEETING_STATUS_SYNC_FAILED meetingId={} meetingStatus={} terminalStatus={} source={} errorCode={}",
                    meetingId,
                    meetingStatus,
                    terminalStatus,
                    REALTIME_FINAL_AUDIO_FALLBACK_SOURCE,
                    ex.getClass().getSimpleName()
            );
        }
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
            syncMeetingStatusSafely(meetingId, status, traceId, authorization);
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
        TranscriptPayload stateTranscriptPayload = buildStateTranscriptPayload(state);
        TranscriptPayload aiTranscriptPayload = fetchTranscriptPayloadFromAiService(meetingId, traceId);
        TranscriptSourceDecision transcriptDecision = selectReadableTranscriptSource(
                stateTranscriptPayload,
                aiTranscriptPayload
        );
        if (!transcriptDecision.payload().readableRows().isEmpty()) {
            String responseStatus = "NOT_FOUND".equals(stateStatus) ? "COMPLETED" : stateStatus;
            log.info(
                    "event=UPLOAD_TRANSCRIPT_COMPLETED traceId={} requestId={} meetingId={} source={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    transcriptDecision.source()
            );
            return buildTranscriptResponse(meetingId, responseStatus, transcriptDecision.payload());
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
        Map<String, Object> response = buildTranscriptResponse(
                meetingId,
                stateStatus,
                TranscriptPayload.empty()
        );
        annotateNoTranscriptAfterFinalize(response, stateStatus);
        return response;
    }

    public TranscriptSearchResponse searchTranscriptEvidenceForMeeting(
            Long meetingId,
            String query,
            int limit,
            int context,
            String traceId,
            String authorization
    ) {
        String trimmedQuery = query == null ? "" : query.trim();
        String normalizedQuery = transcriptEvidenceSearchService.normalizeSearchText(trimmedQuery);
        if (normalizedQuery.length() < 2) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "QUERY_TOO_SHORT");
        }
        int effectiveLimit = transcriptEvidenceSearchService.normalizeLimit(limit);
        int effectiveContext = transcriptEvidenceSearchService.normalizeContext(context);

        long startedAtNanos = System.nanoTime();
        assertMeetingAccess(meetingId, traceId, authorization);
        TranscriptSourceDecision transcriptDecision = loadReadableTranscriptSourceForSearch(meetingId, traceId);
        TranscriptPayload payload = transcriptDecision.payload();
        if (payload.readableRows().isEmpty()) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Transcript is not ready yet.");
        }

        List<Map<String, Object>> stabilizedRows = stabilizeReadableTranscriptRows(payload.readableRows()).rows();
        TranscriptSearchResponse response = transcriptEvidenceSearchService.searchTranscriptEvidence(
                meetingId,
                stabilizedRows,
                trimmedQuery,
                payload.transcriptMode(),
                payload.canonicalTranscriptHash(),
                payload.canonicalTranscriptVersion(),
                effectiveLimit,
                effectiveContext
        );
        long durationMs = Duration.ofNanos(System.nanoTime() - startedAtNanos).toMillis();
        log.info(
                "event=TRANSCRIPT_SEARCH_REQUEST traceId={} requestId={} meetingId={} queryLength={} queryTokenCount={} queryHashPrefix={} limit={} context={} transcriptMode={} transcriptRows={} resultCount={} durationMs={}",
                traceId,
                currentRequestId(traceId),
                meetingId,
                trimmedQuery.length(),
                transcriptEvidenceSearchService.queryTokenCount(trimmedQuery),
                transcriptEvidenceSearchService.queryHashPrefix(trimmedQuery),
                effectiveLimit,
                effectiveContext,
                response.transcriptMode(),
                stabilizedRows.size(),
                response.matches().size(),
                durationMs
        );
        return response;
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

    public Map<String, Object> reanalyzeMeetingAnalysis(
            Long meetingId,
            String mode,
            String reason,
            String traceId,
            String authorization) {
        return reanalyzeMeetingAnalysis(
                meetingId,
                mode,
                reason,
                null,
                null,
                traceId,
                authorization
        );
    }

    public Map<String, Object> reanalyzeMeetingAnalysis(
            Long meetingId,
            String mode,
            String reason,
            String requestedPromptVersion,
            String requestedSchemaVersion,
            String traceId,
            String authorization) {
        assertMeetingAccess(meetingId, traceId, authorization);
        TranscriptPayload transcriptPayload = loadSavedTranscriptPayloadForRerun(meetingId, traceId, authorization);
        String transcriptText = buildTranscriptText(transcriptPayload.readableRows());
        if (transcriptText.isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    "Cannot re-analyze because saved transcript was not found."
            );
        }

        String transcriptHash = resolveReportTranscriptHash(transcriptPayload, transcriptText);
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        Map<String, Object> existingAnalysis = extractAnalysisFromState(state);
        AnalysisVersionSelection versionSelection = selectAnalysisVersionForWrite(
                meetingId,
                "rerun",
                requestedPromptVersion,
                requestedSchemaVersion,
                existingAnalysis,
                traceId
        );
        try {
            return aiServiceClient.rerunAnalysis(
                    meetingId,
                    mode,
                    reason,
                    transcriptText,
                    transcriptHash,
                    versionSelection.promptVersion(),
                    versionSelection.schemaVersion(),
                    GROUPED_ACTION_PLAN_FEATURE_SET,
                    transcriptPayload.canonicalTranscriptHash(),
                    transcriptPayload.canonicalTranscriptVersion(),
                    traceId,
                    authorization
            );
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                throw new ResponseStatusException(
                        HttpStatus.NOT_FOUND,
                        "Cannot re-analyze because saved transcript was not found.",
                        ex
                );
            }
            throw ex;
        }
    }

    public byte[] generateMeetingReportDocx(Long meetingId, String traceId, String authorization) {
        Map<String, Object> meeting = fetchAccessibleMeeting(meetingId, traceId, authorization);
        TranscriptPayload transcriptPayload = loadSavedTranscriptPayloadForExport(
                meetingId,
                traceId,
                authorization,
                false,
                TranscriptExportMode.READABLE
        );
        List<Map<String, Object>> originalTranscriptRows = transcriptPayload.readableRows();
        StabilizedTranscriptResult stabilizedTranscript = stabilizeReadableTranscriptRows(originalTranscriptRows);
        List<Map<String, Object>> transcriptRows = stabilizedTranscript.rows();
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        Map<String, Object> analysisPayload = extractAnalysisFromState(state);
        boolean stateAnalysisCompatible = hasStructuredAnalysis(analysisPayload) && hasAnalysisCacheMetadata(analysisPayload);
        if (!stateAnalysisCompatible) {
            analysisPayload = fetchSavedAnalysisCacheOnlyForReport(
                    meetingId,
                    traceId,
                    authorization,
                    transcriptPayload,
                    transcriptRows
            );
        }
        boolean analysisAvailable = hasStructuredAnalysis(analysisPayload);
        RawTranscriptPreview readablePreview = transcriptPayload.isCanonicalMode()
                ? buildCanonicalTranscriptPreviewRows(transcriptRows)
                : buildReadableTranscriptPreviewRows(transcriptRows, originalTranscriptRows);

        if (transcriptRows.isEmpty() && !analysisAvailable) {
            throw new ResponseStatusException(
                    HttpStatus.NOT_FOUND,
                    "Transcript is not ready yet."
            );
        }

        MeetingReportData reportData = assembleMeetingReportData(
                meetingId,
                meeting,
                state,
                transcriptPayload,
                transcriptRows,
                readablePreview.rows(),
                readablePreview.previewLimited(),
                analysisPayload,
                analysisAvailable
        );
        return meetingReportDocxGenerator.generate(reportData);
    }

    public MeetingActionPlanData getMeetingActionPlan(Long meetingId, String traceId, String authorization) {
        return buildMeetingActionPlan(meetingId, traceId, authorization);
    }

    public byte[] generateMeetingActionPlanDocx(Long meetingId, String traceId, String authorization) {
        long startedAtNanos = System.nanoTime();
        MeetingActionPlanData actionPlan = buildMeetingActionPlan(meetingId, traceId, authorization);
        byte[] docxBytes = meetingActionPlanDocxGenerator.generate(actionPlan);
        long durationMs = Duration.ofNanos(System.nanoTime() - startedAtNanos).toMillis();
        log.info(
                "event=ACTION_PLAN_EXPORT_REQUEST traceId={} requestId={} meetingId={} format=docx actionItemCount={} evidenceCount={} analysisSource={} docxFileSize={} durationMs={}",
                traceId,
                currentRequestId(traceId),
                meetingId,
                actionPlan.actionItems().size(),
                countVerifiedEvidence(actionPlan),
                actionPlan.analysisMetadata().analysisSource(),
                docxBytes.length,
                durationMs
        );
        return docxBytes;
    }

    public byte[] generateMeetingTranscriptTxt(Long meetingId, String traceId, String authorization) {
        return generateMeetingTranscriptTxt(meetingId, traceId, authorization, "readable");
    }

    public byte[] generateMeetingTranscriptTxt(Long meetingId, String traceId, String authorization, String mode) {
        TranscriptExportMode exportMode = TranscriptExportMode.from(mode);
        Map<String, Object> meeting = fetchAccessibleMeeting(meetingId, traceId, authorization);
        TranscriptPayload savedTranscriptPayload = loadSavedTranscriptPayloadForExport(
                meetingId,
                traceId,
                authorization,
                true,
                exportMode
        );
        List<Map<String, Object>> selectedRows = exportMode == TranscriptExportMode.RAW
                ? savedTranscriptPayload.rawRows()
                : stabilizeReadableTranscriptRows(savedTranscriptPayload.readableRows()).rows();
        List<MeetingReportData.RawTranscriptRow> transcriptRows = exportMode == TranscriptExportMode.RAW
                ? buildRawTranscriptRows(selectedRows)
                : savedTranscriptPayload.isCanonicalMode()
                        ? buildRawTranscriptRows(selectedRows)
                        : buildReadableTranscriptRows(selectedRows);
        String content = buildTranscriptTxt(meetingId, meeting, selectedRows, transcriptRows, exportMode);
        return content.getBytes(StandardCharsets.UTF_8);
    }

    public byte[] generateMeetingTranscriptCsv(Long meetingId, String traceId, String authorization) {
        return generateMeetingTranscriptCsv(meetingId, traceId, authorization, "readable");
    }

    public byte[] generateMeetingTranscriptCsv(Long meetingId, String traceId, String authorization, String mode) {
        TranscriptExportMode exportMode = TranscriptExportMode.from(mode);
        Map<String, Object> meeting = fetchAccessibleMeeting(meetingId, traceId, authorization);
        TranscriptPayload savedTranscriptPayload = loadSavedTranscriptPayloadForExport(
                meetingId,
                traceId,
                authorization,
                true,
                exportMode
        );
        List<Map<String, Object>> selectedRows = exportMode == TranscriptExportMode.RAW
                ? savedTranscriptPayload.rawRows()
                : stabilizeReadableTranscriptRows(savedTranscriptPayload.readableRows()).rows();
        List<MeetingReportData.RawTranscriptRow> transcriptRows = exportMode == TranscriptExportMode.RAW
                ? buildRawTranscriptRows(selectedRows)
                : savedTranscriptPayload.isCanonicalMode()
                        ? buildRawTranscriptRows(selectedRows)
                        : buildReadableTranscriptRows(selectedRows);
        String content = buildTranscriptCsv(transcriptRows);
        return content.getBytes(StandardCharsets.UTF_8);
    }

    private MeetingReportData assembleMeetingReportData(
            Long meetingId,
            Map<String, Object> meeting,
            Map<String, Object> state,
            TranscriptPayload transcriptPayload,
            List<Map<String, Object>> transcriptRows,
            List<MeetingReportData.RawTranscriptRow> transcriptPreviewRows,
            boolean transcriptPreviewLimited,
            Map<String, Object> analysisPayload,
            boolean analysisAvailable
    ) {
        MeetingReportData.MeetingMetadata metadata = new MeetingReportData.MeetingMetadata(
                meetingId,
                safeCell(meeting.get("title")),
                safeCell(meeting.get("createdAt")),
                safeCell(meeting.get("language")),
                detectTranscriptLanguage(transcriptRows),
                safeCell(meeting.get("status")),
                safeCell(meeting.get("originalFileName")),
                safeCell(meeting.get("ownerUserId")),
                safeCell(meeting.get("fileSize"))
        );

        List<String> decisions = extractStringList(analysisPayload, "keyDecisions", "decisions");
        List<String> keywords = extractStringList(analysisPayload, "keywords");
        List<String> technicalTerms = extractTechnicalTerms(analysisPayload);
        List<MeetingReportData.ReportActionItem> actionItems = extractReportActionItems(analysisPayload);
        List<String> risks = extractStringList(analysisPayload, "risks");
        List<String> blockers = extractStringList(analysisPayload, "blockers");
        List<String> questions = extractStringList(analysisPayload, "questions");
        List<String> nextSteps = extractStringList(analysisPayload, "nextSteps", "next_steps");
        String summary = resolveSummary(analysisPayload, analysisAvailable);

        List<MeetingReportData.AnalyzedHighlightRow> analyzedHighlightRows = buildAnalyzedHighlights(
                summary,
                decisions,
                actionItems,
                risks,
                blockers,
                questions,
                nextSteps
        );

        String promptVersion = analysisAvailable
                ? resolvePromptVersion(analysisPayload)
                : firstNonBlank(analysisPayload.get("promptVersion"), analysisPayload.get("prompt_version"));
        String schemaVersion = analysisAvailable
                ? resolveSchemaVersion(analysisPayload)
                : firstNonBlank(analysisPayload.get("schemaVersion"), analysisPayload.get("schema_version"));
        String transcriptHash = firstNonBlank(
                analysisPayload.get("transcriptHash"),
                analysisPayload.get("transcript_hash"),
                analysisPayload.get("canonicalTranscriptHash"),
                analysisPayload.get("canonical_transcript_hash"),
                transcriptPayload == null ? null : transcriptPayload.canonicalTranscriptHash()
        );
        String canonicalTranscriptHash = firstNonBlank(
                analysisPayload.get("canonicalTranscriptHash"),
                analysisPayload.get("canonical_transcript_hash"),
                transcriptPayload == null ? null : transcriptPayload.canonicalTranscriptHash()
        );
        String canonicalTranscriptVersion = firstNonBlank(
                analysisPayload.get("canonicalTranscriptVersion"),
                analysisPayload.get("canonical_transcript_version"),
                transcriptPayload == null ? null : transcriptPayload.canonicalTranscriptVersion()
        );
        String analysisInputMode = firstNonBlank(
                analysisPayload.get("analysisInputMode"),
                analysisPayload.get("analysis_input_mode"),
                transcriptPayload == null
                        ? null
                        : (transcriptPayload.isCanonicalMode() ? "canonical" : "readable_fallback")
        );
        String source = resolveAnalysisMetadataSource(analysisPayload, promptVersion, schemaVersion, analysisAvailable);

        MeetingReportData.AnalysisMetadata analysisMetadata = new MeetingReportData.AnalysisMetadata(
                resolveAnalysisMetadataStatus(analysisPayload, state, analysisAvailable),
                safeCell(analysisPayload.get("cacheHit")),
                safeCell(analysisPayload.get("stale")),
                safeCell(analysisPayload.get("staleReason")),
                safeCell(analysisPayload.get("provider")),
                safeCell(analysisPayload.get("model")),
                promptVersion,
                schemaVersion,
                transcriptHash,
                canonicalTranscriptHash,
                canonicalTranscriptVersion,
                analysisInputMode,
                safeCell(analysisPayload.get("lastAnalyzedAt")),
                safeCell(analysisPayload.get("retryAfterSeconds")),
                safeCell(analysisPayload.get("confidence")),
                firstNonBlank(analysisPayload.get("domainMode"), analysisPayload.get("domain_mode")),
                source
        );

        return new MeetingReportData(
                metadata,
                summary,
                keywords,
                technicalTerms,
                decisions,
                actionItems,
                risks,
                blockers,
                questions,
                nextSteps,
                transcriptPreviewRows,
                transcriptPreviewLimited,
                analyzedHighlightRows,
                analysisMetadata,
                analysisAvailable
        );
    }

    private MeetingActionPlanData buildMeetingActionPlan(Long meetingId, String traceId, String authorization) {
        Map<String, Object> meeting = fetchAccessibleMeeting(meetingId, traceId, authorization);
        TranscriptPayload transcriptPayload = loadSavedTranscriptPayloadForExport(
                meetingId,
                traceId,
                authorization,
                false,
                TranscriptExportMode.READABLE
        );
        List<Map<String, Object>> transcriptRows = transcriptPayload.readableRows().isEmpty()
                ? List.of()
                : stabilizeReadableTranscriptRows(transcriptPayload.readableRows()).rows();
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        Map<String, Object> analysisPayload = extractAnalysisFromState(state);
        if (!hasStructuredAnalysis(analysisPayload) && !transcriptRows.isEmpty()) {
            analysisPayload = fetchSavedAnalysisCacheOnlyForReport(
                    meetingId,
                    traceId,
                    authorization,
                    transcriptPayload,
                    transcriptRows
            );
        }
        if (!hasStructuredAnalysis(analysisPayload)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "EXPORT_ANALYSIS_REQUIRED");
        }

        MeetingActionPlanData actionPlan = meetingActionPlanBuilder.build(
                meetingId,
                meeting,
                analysisPayload,
                query -> resolveActionPlanEvidence(
                        meetingId,
                        transcriptRows,
                        transcriptPayload,
                        query
                ),
                transcriptPayload.canonicalTranscriptHash(),
                transcriptPayload.canonicalTranscriptVersion(),
                Instant.now()
        );
        log.info(
                "event=ACTION_PLAN_PREVIEW_REQUEST traceId={} requestId={} meetingId={} actionItemCount={} evidenceCount={} analysisSource={}",
                traceId,
                currentRequestId(traceId),
                meetingId,
                actionPlan.actionItems().size(),
                countVerifiedEvidence(actionPlan),
                actionPlan.analysisMetadata().analysisSource()
        );
        return actionPlan;
    }

    private TranscriptEvidenceMatch resolveActionPlanEvidence(
            Long meetingId,
            List<Map<String, Object>> transcriptRows,
            TranscriptPayload transcriptPayload,
            String query
    ) {
        if (transcriptRows == null || transcriptRows.isEmpty() || query == null || query.isBlank()) {
            return null;
        }
        try {
            TranscriptSearchResponse response = transcriptEvidenceSearchService.searchTranscriptEvidence(
                    meetingId,
                    transcriptRows,
                    query,
                    transcriptPayload.transcriptMode(),
                    transcriptPayload.canonicalTranscriptHash(),
                    transcriptPayload.canonicalTranscriptVersion(),
                    1,
                    1
            );
            return response.matches().isEmpty() ? null : response.matches().get(0);
        } catch (ResponseStatusException ex) {
            if (ex.getStatusCode().is4xxClientError()) {
                return null;
            }
            throw ex;
        }
    }

    private long countVerifiedEvidence(MeetingActionPlanData actionPlan) {
        return actionPlan.actionItems().stream()
                .filter(item -> item.evidence() != null)
                .count();
    }

    private RawTranscriptPreview buildReadableTranscriptPreviewRows(List<Map<String, Object>> transcriptRows) {
        return buildReadableTranscriptPreviewRows(transcriptRows, transcriptRows);
    }

    private RawTranscriptPreview buildReadableTranscriptPreviewRows(
            List<Map<String, Object>> transcriptRows,
            List<Map<String, Object>> sourceRowsForLimit
    ) {
        List<MeetingReportData.RawTranscriptRow> readableRows = buildReadableTranscriptRows(transcriptRows);
        List<Map<String, Object>> sourceRows = sourceRowsForLimit == null ? transcriptRows : sourceRowsForLimit;
        boolean previewLimited = sourceRows != null
                && !sourceRows.isEmpty()
                && (readableRows.size() != sourceRows.size() || readableRows.size() > 30);
        if (readableRows.size() > 30) {
            return new RawTranscriptPreview(new ArrayList<>(readableRows.subList(0, 30)), true);
        }
        return new RawTranscriptPreview(readableRows, previewLimited);
    }

    private RawTranscriptPreview buildCanonicalTranscriptPreviewRows(List<Map<String, Object>> transcriptRows) {
        List<MeetingReportData.RawTranscriptRow> canonicalRows = buildRawTranscriptRows(transcriptRows);
        if (canonicalRows.size() > 30) {
            return new RawTranscriptPreview(new ArrayList<>(canonicalRows.subList(0, 30)), true);
        }
        return new RawTranscriptPreview(canonicalRows, false);
    }

    private List<MeetingReportData.RawTranscriptRow> buildRawTranscriptRows(List<Map<String, Object>> transcriptRows) {
        if (transcriptRows == null || transcriptRows.isEmpty()) {
            return List.of();
        }

        List<MeetingReportData.RawTranscriptRow> rows = new ArrayList<>();
        int index = 1;
        for (Map<String, Object> row : transcriptRows) {
            rows.add(toTranscriptRow(index++, row));
        }
        return rows;
    }

    private List<MeetingReportData.RawTranscriptRow> buildReadableTranscriptRows(List<Map<String, Object>> transcriptRows) {
        if (transcriptRows == null || transcriptRows.isEmpty()) {
            return List.of();
        }

        List<RawTranscriptCandidate> candidates = new ArrayList<>();
        for (Map<String, Object> row : transcriptRows) {
            String text = row.get("text") == null ? "" : String.valueOf(row.get("text"));
            if (text.isBlank()) {
                continue;
            }
            double start = parseTimeSeconds(row.get("start_time"), row.get("startTime"));
            double end = parseTimeSeconds(row.get("end_time"), row.get("endTime"));
            String speaker = rawText(row.get("speaker"));
            candidates.add(new RawTranscriptCandidate(start, end, speaker, text));
        }

        candidates.sort((a, b) -> {
            int byStart = Double.compare(a.startTimeSeconds(), b.startTimeSeconds());
            if (byStart != 0) {
                return byStart;
            }
            int byEnd = Double.compare(a.endTimeSeconds(), b.endTimeSeconds());
            if (byEnd != 0) {
                return byEnd;
            }
            int bySpeaker = a.speaker().compareToIgnoreCase(b.speaker());
            if (bySpeaker != 0) {
                return bySpeaker;
            }
            return a.rawText().compareToIgnoreCase(b.rawText());
        });

        List<RawTranscriptCandidate> deduplicated = deduplicateExactCandidates(candidates);
        List<RawTranscriptCandidate> filtered = dropShortContainedFragments(deduplicated);
        List<RawTranscriptCandidate> collapsed = collapseContainedNearDuplicates(filtered);
        if (collapsed.isEmpty()) {
            collapsed = filtered.isEmpty() ? (deduplicated.isEmpty() ? candidates : deduplicated) : filtered;
        }

        List<MeetingReportData.RawTranscriptRow> rows = new ArrayList<>();
        int index = 1;
        for (RawTranscriptCandidate row : collapsed) {
            rows.add(new MeetingReportData.RawTranscriptRow(
                    index++,
                    formatTranscriptTime(row.startTimeSeconds()),
                    formatTranscriptTime(row.endTimeSeconds()),
                    row.speaker(),
                    row.rawText()
            ));
        }
        return rows;
    }

    private MeetingReportData.RawTranscriptRow toTranscriptRow(int index, Map<String, Object> row) {
        double start = parseTimeSeconds(row.get("start_time"), row.get("startTime"));
        double end = parseTimeSeconds(row.get("end_time"), row.get("endTime"));
        return new MeetingReportData.RawTranscriptRow(
                index,
                formatTranscriptTime(start),
                formatTranscriptTime(end),
                rawText(row.get("speaker")),
                row.get("text") == null ? "" : String.valueOf(row.get("text"))
        );
    }

    private StabilizedTranscriptResult stabilizeReadableTranscriptRows(List<Map<String, Object>> transcriptRows) {
        if (transcriptRows == null || transcriptRows.isEmpty()) {
            return new StabilizedTranscriptResult(List.of(), Map.of(), null);
        }
        if (!speakerStabilizationEnabled) {
            return fallbackSortedReadableTranscriptRows(transcriptRows);
        }

        try {
            List<SpeakerDisplaySegment> segments = new ArrayList<>();
            LinkedHashSet<String> rawSpeakers = new LinkedHashSet<>();
            int largestObservedSpeakerLabelCount = 0;
            int originalIndex = 0;
            for (Map<String, Object> row : transcriptRows) {
                if (row == null) {
                    originalIndex++;
                    continue;
                }
                String text = row.get("text") == null ? "" : String.valueOf(row.get("text"));
                if (text.isBlank()) {
                    originalIndex++;
                    continue;
                }
                String rawSpeaker = resolveProviderSpeaker(row);
                String rawSpeakerKey = canonicalSpeakerKey(rawSpeaker);
                if (!rawSpeakerKey.isBlank() && !"UNKNOWN".equals(rawSpeakerKey)) {
                    rawSpeakers.add(rawSpeakerKey);
                }
                largestObservedSpeakerLabelCount = Math.max(
                        largestObservedSpeakerLabelCount,
                        parseSpeakerOrdinal(rawSpeaker)
                );

                segments.add(SpeakerDisplaySegment.fromRow(
                        row,
                        originalIndex++,
                        text,
                        rawSpeaker,
                        parseTimeSeconds(row.get("start_time"), row.get("startTime"), row.get("start")),
                        parseTimeSeconds(row.get("end_time"), row.get("endTime"), row.get("end")),
                        hasTranscriptTiming(row)
                ));
            }

            if (segments.isEmpty()) {
                return fallbackSortedReadableTranscriptRows(transcriptRows);
            }

            sortSpeakerSegments(segments);
            assignStableSpeakers(segments);

            SpeakerStabilizationCounters counters = new SpeakerStabilizationCounters();
            mergeShortSpeakerIslands(segments, counters);
            List<SpeakerDisplaySegment> mergedSegments = mergeStableSpeakerSegments(segments, counters);
            sortSpeakerSegments(mergedSegments);

            LinkedHashSet<String> stableSpeakers = new LinkedHashSet<>();
            for (SpeakerDisplaySegment segment : mergedSegments) {
                stableSpeakers.add(segment.stableSpeaker);
            }

            Map<String, Object> speakerStats = buildSpeakerStats(
                    rawSpeakers.size(),
                    stableSpeakers.size(),
                    counters.mergedIslandCount,
                    counters.mergedTinyFragmentCount,
                    largestObservedSpeakerLabelCount
            );

            if (speakerStabilizationLogStats) {
                log.info(
                        "SPEAKER_STABILIZATION_STATS rawSpeakerCount={} stableSpeakerCount={} mergedIslandCount={} mergedTinyFragmentCount={} version={} dryRun={}",
                        speakerStats.get("rawSpeakerCount"),
                        speakerStats.get("stableSpeakerCount"),
                        speakerStats.get("mergedIslandCount"),
                        speakerStats.get("mergedTinyFragmentCount"),
                        speakerStats.get("stabilizationVersion"),
                        speakerStabilizationDryRun
                );
            }

            List<Map<String, Object>> outputRows = speakerStabilizationDryRun
                    ? copyRowsWithSpeakerMetadata(transcriptRows)
                    : mergedSegments.stream().map(this::toStabilizedTranscriptRow).toList();
            return new StabilizedTranscriptResult(
                    sortTranscriptRowsByTimeline(outputRows),
                    speakerStats,
                    normalizedSpeakerStabilizationVersion()
            );
        } catch (RuntimeException ex) {
            log.warn(
                    "SPEAKER_STABILIZATION_FALLBACK errorCode={} reason=timeline_sort_preserved",
                    ex.getClass().getSimpleName(),
                    ex
            );
            return fallbackSortedReadableTranscriptRows(transcriptRows);
        }
    }

    private StabilizedTranscriptResult fallbackSortedReadableTranscriptRows(List<Map<String, Object>> transcriptRows) {
        return new StabilizedTranscriptResult(sortTranscriptRowsByTimeline(copyTranscriptRows(transcriptRows)), Map.of(), null);
    }

    private List<Map<String, Object>> copyTranscriptRows(List<Map<String, Object>> transcriptRows) {
        if (transcriptRows == null || transcriptRows.isEmpty()) {
            return List.of();
        }
        List<Map<String, Object>> copied = new ArrayList<>();
        for (Map<String, Object> row : transcriptRows) {
            if (row != null) {
                copied.add(new HashMap<>(row));
            }
        }
        return copied;
    }

    private List<Map<String, Object>> copyRowsWithSpeakerMetadata(List<Map<String, Object>> transcriptRows) {
        List<Map<String, Object>> copied = new ArrayList<>();
        for (Map<String, Object> row : transcriptRows) {
            if (row == null) {
                continue;
            }
            Map<String, Object> copy = new HashMap<>(row);
            String rawSpeaker = resolveProviderSpeaker(row);
            if (!rawSpeaker.isBlank()) {
                copy.putIfAbsent("providerSpeaker", rawSpeaker);
                copy.putIfAbsent("originalSpeaker", rawSpeaker);
            }
            copy.put("speakerStabilizationVersion", normalizedSpeakerStabilizationVersion());
            copied.add(copy);
        }
        return copied;
    }

    private void sortSpeakerSegments(List<SpeakerDisplaySegment> segments) {
        boolean hasTiming = segments.stream().anyMatch(segment -> segment.hasTiming);
        if (!hasTiming) {
            return;
        }
        segments.sort((left, right) -> {
            int byStart = Double.compare(left.startTimeSeconds, right.startTimeSeconds);
            if (byStart != 0) {
                return byStart;
            }
            int byEnd = Double.compare(left.endTimeSeconds, right.endTimeSeconds);
            if (byEnd != 0) {
                return byEnd;
            }
            return Integer.compare(left.originalIndex, right.originalIndex);
        });
    }

    private List<Map<String, Object>> sortTranscriptRowsByTimeline(List<Map<String, Object>> transcriptRows) {
        if (transcriptRows == null || transcriptRows.size() <= 1) {
            return transcriptRows == null ? List.of() : transcriptRows;
        }
        boolean hasTiming = transcriptRows.stream().anyMatch(this::hasTranscriptTiming);
        if (!hasTiming) {
            return transcriptRows;
        }
        List<Map<String, Object>> sorted = new ArrayList<>(transcriptRows);
        sorted.sort((left, right) -> {
            int byStart = Double.compare(
                    parseTranscriptStartTime(left),
                    parseTranscriptStartTime(right)
            );
            if (byStart != 0) {
                return byStart;
            }

            int byEnd = Double.compare(
                    parseTranscriptEndTime(left),
                    parseTranscriptEndTime(right)
            );
            if (byEnd != 0) {
                return byEnd;
            }

            int byOriginalIndex = Double.compare(
                    parseTranscriptOriginalIndex(left),
                    parseTranscriptOriginalIndex(right)
            );
            if (byOriginalIndex != 0) {
                return byOriginalIndex;
            }

            return 0;
        });
        return sorted;
    }

    private double parseTranscriptStartTime(Map<String, Object> row) {
        if (row == null) {
            return 0d;
        }
        return parseTimeSeconds(row.get("start_time"), row.get("startTime"), row.get("start"));
    }

    private double parseTranscriptEndTime(Map<String, Object> row) {
        if (row == null) {
            return 0d;
        }
        return parseTimeSeconds(row.get("end_time"), row.get("endTime"), row.get("end"));
    }

    private double parseTranscriptOriginalIndex(Map<String, Object> row) {
        if (row == null) {
            return Double.POSITIVE_INFINITY;
        }
        String raw = firstNonBlank(row.get("originalIndex"), row.get("original_index"));
        if (raw.isBlank()) {
            return Double.POSITIVE_INFINITY;
        }
        try {
            return Double.parseDouble(raw);
        } catch (NumberFormatException ex) {
            return Double.POSITIVE_INFINITY;
        }
    }

    private void assignStableSpeakers(List<SpeakerDisplaySegment> segments) {
        Map<String, String> stableSpeakerMap = new LinkedHashMap<>();
        int maxSpeakers = Math.max(1, speakerMaxReasonableCount);
        for (SpeakerDisplaySegment segment : segments) {
            String speakerKey = canonicalSpeakerKey(segment.originalSpeaker());
            String stableSpeaker = stableSpeakerMap.get(speakerKey);
            if (stableSpeaker == null) {
                int nextOrdinal = stableSpeakerMap.size() >= maxSpeakers
                        ? maxSpeakers
                        : stableSpeakerMap.size() + 1;
                stableSpeaker = "SPEAKER_" + nextOrdinal;
                stableSpeakerMap.put(speakerKey, stableSpeaker);
            }
            segment.stableSpeaker = stableSpeaker;
        }
    }

    private void mergeShortSpeakerIslands(
            List<SpeakerDisplaySegment> segments,
            SpeakerStabilizationCounters counters
    ) {
        if (segments.size() < 3) {
            return;
        }

        int index = 1;
        while (index < segments.size() - 1) {
            int runStart = index;
            String islandSpeaker = segments.get(index).stableSpeaker;
            int runEnd = runStart;
            while (runEnd + 1 < segments.size()
                    && islandSpeaker.equals(segments.get(runEnd + 1).stableSpeaker)) {
                runEnd++;
            }

            if (runStart == 0 || runEnd >= segments.size() - 1) {
                index = runEnd + 1;
                continue;
            }

            SpeakerDisplaySegment before = segments.get(runStart - 1);
            SpeakerDisplaySegment after = segments.get(runEnd + 1);
            if (!before.stableSpeaker.equals(after.stableSpeaker)
                    || before.stableSpeaker.equals(islandSpeaker)) {
                index = runEnd + 1;
                continue;
            }

            SpeakerDisplaySegment firstIsland = segments.get(runStart);
            SpeakerDisplaySegment lastIsland = segments.get(runEnd);
            double islandDuration = Math.max(
                    0d,
                    resolveEnd(lastIsland.startTimeSeconds, lastIsland.endTimeSeconds) - firstIsland.startTimeSeconds
            );
            double beforeGap = gapBetween(before, firstIsland);
            double afterGap = gapBetween(lastIsland, after);
            double mergedDuration = combinedDuration(before, after);
            String islandText = combineSegmentText(segments, runStart, runEnd);

            if (islandDuration <= speakerIslandMaxSeconds
                    && beforeGap <= speakerMaxGapSeconds
                    && afterGap <= speakerMaxGapSeconds
                    && mergedDuration <= speakerMaxMergedTurnSeconds
                    && isFragmentLikeSpeakerIsland(islandText)) {
                for (int rewriteIndex = runStart; rewriteIndex <= runEnd; rewriteIndex++) {
                    SpeakerDisplaySegment segment = segments.get(rewriteIndex);
                    segment.stableSpeaker = before.stableSpeaker;
                    segment.mergedIsland = true;
                }
                counters.mergedIslandCount++;
            }

            index = runEnd + 1;
        }
    }

    private List<SpeakerDisplaySegment> mergeStableSpeakerSegments(
            List<SpeakerDisplaySegment> segments,
            SpeakerStabilizationCounters counters
    ) {
        if (segments.isEmpty()) {
            return List.of();
        }

        List<SpeakerDisplaySegment> merged = new ArrayList<>();
        SpeakerDisplaySegment current = segments.get(0);
        for (int index = 1; index < segments.size(); index++) {
            SpeakerDisplaySegment next = segments.get(index);
            if (!canMergeStableSpeakerSegments(current, next)) {
                merged.add(current);
                current = next;
                continue;
            }
            if (isTinySpeakerSegment(current) || isTinySpeakerSegment(next)) {
                counters.mergedTinyFragmentCount++;
            }
            current = current.merge(next);
        }
        merged.add(current);
        return merged;
    }

    private boolean canMergeStableSpeakerSegments(SpeakerDisplaySegment current, SpeakerDisplaySegment next) {
        if (!current.stableSpeaker.equals(next.stableSpeaker)) {
            return false;
        }
        if (!current.hasTiming && !next.hasTiming && !isTinySpeakerSegment(current) && !isTinySpeakerSegment(next)) {
            return false;
        }
        if (gapBetween(current, next) > speakerMaxGapSeconds) {
            return false;
        }
        if (hasContainedSpeakerText(current.text, next.text)) {
            return false;
        }
        return combinedDuration(current, next) <= speakerMaxMergedTurnSeconds;
    }

    private Map<String, Object> toStabilizedTranscriptRow(SpeakerDisplaySegment segment) {
        Map<String, Object> row = new HashMap<>(segment.row);
        row.put("speaker", segment.stableSpeaker);
        row.put("text", segment.text);
        row.put("start_time", segment.startTimeSeconds);
        row.put("end_time", resolveEnd(segment.startTimeSeconds, segment.endTimeSeconds));
        if (segment.row.containsKey("startTime")) {
            row.put("startTime", segment.startTimeSeconds);
        }
        if (segment.row.containsKey("endTime")) {
            row.put("endTime", resolveEnd(segment.startTimeSeconds, segment.endTimeSeconds));
        }
        if (!segment.providerSpeakers.isEmpty()) {
            row.put("providerSpeaker", String.join("/", segment.providerSpeakers));
            row.put("providerSpeakers", new ArrayList<>(segment.providerSpeakers));
        }
        if (!segment.originalSpeakers.isEmpty()) {
            row.put("originalSpeaker", String.join("/", segment.originalSpeakers));
            row.put("originalSpeakers", new ArrayList<>(segment.originalSpeakers));
        }
        row.put("speakerStabilizationVersion", normalizedSpeakerStabilizationVersion());
        return row;
    }

    private Map<String, Object> buildSpeakerStats(
            int rawSpeakerCount,
            int stableSpeakerCount,
            int mergedIslandCount,
            int mergedTinyFragmentCount,
            int largestObservedSpeakerLabelCount
    ) {
        Map<String, Object> stats = new LinkedHashMap<>();
        stats.put("rawSpeakerCount", rawSpeakerCount);
        stats.put("stableSpeakerCount", stableSpeakerCount);
        stats.put("mergedIslandCount", mergedIslandCount);
        stats.put("mergedTinyFragmentCount", mergedTinyFragmentCount);
        stats.put("stabilizationVersion", normalizedSpeakerStabilizationVersion());
        stats.put("largestObservedSpeakerLabelCount", largestObservedSpeakerLabelCount);
        return stats;
    }

    private String resolveProviderSpeaker(Map<String, Object> row) {
        return firstNonBlank(
                row.get("providerSpeaker"),
                row.get("provider_speaker"),
                row.get("originalSpeaker"),
                row.get("original_speaker"),
                row.get("speaker")
        );
    }

    private String canonicalSpeakerKey(String value) {
        String normalized = firstNonBlank(value).trim();
        if (normalized.isBlank()
                || "system".equalsIgnoreCase(normalized)
                || "unknown".equalsIgnoreCase(normalized)
                || "n/a".equalsIgnoreCase(normalized)) {
            return "UNKNOWN";
        }
        return normalized.replaceAll("\\s+", " ").toUpperCase(Locale.ROOT);
    }

    private int parseSpeakerOrdinal(String value) {
        String normalized = firstNonBlank(value);
        if (normalized.isBlank()) {
            return 0;
        }
        String candidate = normalized
                .replaceFirst("(?i)^speaker[_\\s-]*", "")
                .trim();
        if (!candidate.matches("\\d+")) {
            return 0;
        }
        try {
            return Integer.parseInt(candidate);
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private boolean isTinySpeakerSegment(SpeakerDisplaySegment segment) {
        double duration = Math.max(
                0d,
                resolveEnd(segment.startTimeSeconds, segment.endTimeSeconds) - segment.startTimeSeconds
        );
        String normalizedText = normalizeTranscriptForCompare(segment.text);
        return duration <= speakerMinSegmentSeconds
                || normalizedTokenCount(normalizedText) <= READABLE_TINY_FRAGMENT_MAX_WORDS;
    }

    private boolean isFragmentLikeSpeakerIsland(String text) {
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isBlank()) {
            return true;
        }
        char lastCharacter = trimmed.charAt(trimmed.length() - 1);
        if (lastCharacter == '.' || lastCharacter == '!' || lastCharacter == '?') {
            return false;
        }
        String normalizedText = normalizeTranscriptForCompare(text);
        return isObviouslyIncompleteTranscriptRow(text, normalizedText);
    }

    private boolean hasContainedSpeakerText(String left, String right) {
        String normalizedLeft = normalizeTranscriptForCompare(left);
        String normalizedRight = normalizeTranscriptForCompare(right);
        if (normalizedLeft.isBlank() || normalizedRight.isBlank()) {
            return false;
        }
        return normalizedLeft.contains(normalizedRight) || normalizedRight.contains(normalizedLeft);
    }

    private String combineSegmentText(List<SpeakerDisplaySegment> segments, int start, int end) {
        String combined = "";
        for (int index = start; index <= end; index++) {
            combined = appendRawText(combined, segments.get(index).text);
        }
        return combined;
    }

    private double gapBetween(SpeakerDisplaySegment left, SpeakerDisplaySegment right) {
        double leftEnd = resolveEnd(left.startTimeSeconds, left.endTimeSeconds);
        double rightStart = right.startTimeSeconds;
        if (leftEnd >= rightStart) {
            return 0d;
        }
        return rightStart - leftEnd;
    }

    private double combinedDuration(SpeakerDisplaySegment left, SpeakerDisplaySegment right) {
        double start = Math.min(left.startTimeSeconds, right.startTimeSeconds);
        double end = Math.max(
                resolveEnd(left.startTimeSeconds, left.endTimeSeconds),
                resolveEnd(right.startTimeSeconds, right.endTimeSeconds)
        );
        return Math.max(0d, end - start);
    }

    private String normalizedSpeakerStabilizationVersion() {
        String version = firstNonBlank(speakerStabilizationVersion);
        return version.isBlank() ? DEFAULT_SPEAKER_STABILIZATION_VERSION : version;
    }

    private boolean isObviouslyIncompleteTranscriptRow(String text, String normalizedText) {
        String trimmed = text == null ? "" : text.trim();
        if (trimmed.isBlank()) {
            return true;
        }
        if (normalizedTokenCount(normalizedText) < 4) {
            return true;
        }
        char lastCharacter = trimmed.charAt(trimmed.length() - 1);
        boolean endsLikeSentence = lastCharacter == '.' || lastCharacter == '!' || lastCharacter == '?';
        if (endsLikeSentence) {
            return false;
        }
        return trimmed.length() < 80;
    }

    private int normalizedTokenCount(String normalizedValue) {
        if (normalizedValue == null || normalizedValue.isBlank()) {
            return 0;
        }
        return normalizedValue.trim().split("\\s+").length;
    }

    private List<RawTranscriptCandidate> deduplicateExactCandidates(List<RawTranscriptCandidate> candidates) {
        if (candidates.isEmpty()) {
            return List.of();
        }

        List<RawTranscriptCandidate> deduplicated = new ArrayList<>();
        for (RawTranscriptCandidate candidate : candidates) {
            String currentNormalized = normalizeTranscriptForCompare(candidate.rawText());
            if (currentNormalized.isBlank()) {
                continue;
            }
            boolean isDuplicate = false;
            for (int i = deduplicated.size() - 1; i >= 0; i--) {
                RawTranscriptCandidate existing = deduplicated.get(i);
                if (candidate.startTimeSeconds() - existing.startTimeSeconds() > READABLE_DUPLICATE_WINDOW_SECONDS) {
                    break;
                }
                String existingNormalized = normalizeTranscriptForCompare(existing.rawText());
                if (!existingNormalized.equals(currentNormalized)) {
                    continue;
                }
                if (isWithinReadableWindow(existing, candidate)) {
                    isDuplicate = true;
                    break;
                }
            }
            if (isDuplicate) {
                continue;
            }
            deduplicated.add(candidate);
        }
        return deduplicated;
    }

    private List<RawTranscriptCandidate> dropShortContainedFragments(List<RawTranscriptCandidate> rows) {
        if (rows.size() <= 1) {
            return rows;
        }

        List<RawTranscriptCandidate> filtered = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            RawTranscriptCandidate current = rows.get(i);
            String currentNormalized = normalizeTranscriptForCompare(current.rawText());
            if (currentNormalized.isBlank()) {
                continue;
            }

            int currentWordCount = normalizedTokenCount(currentNormalized);
            boolean tinyFragment = currentWordCount > 0 && currentWordCount <= READABLE_TINY_FRAGMENT_MAX_WORDS;
            if (!tinyFragment) {
                filtered.add(current);
                continue;
            }

            if (isContainedInNearbyLonger(current, currentNormalized, currentWordCount, rows, i)) {
                continue;
            }
            filtered.add(current);
        }
        return filtered;
    }

    private List<RawTranscriptCandidate> collapseContainedNearDuplicates(List<RawTranscriptCandidate> rows) {
        if (rows.size() <= 1) {
            return rows;
        }

        List<RawTranscriptCandidate> collapsed = new ArrayList<>();
        for (int i = 0; i < rows.size(); i++) {
            RawTranscriptCandidate current = rows.get(i);
            String currentNormalized = normalizeTranscriptForCompare(current.rawText());
            if (currentNormalized.isBlank()) {
                continue;
            }

            int currentWordCount = normalizedTokenCount(currentNormalized);
            if (currentWordCount <= READABLE_TINY_FRAGMENT_MAX_WORDS
                    || currentWordCount > READABLE_COLLAPSIBLE_FRAGMENT_MAX_WORDS) {
                collapsed.add(current);
                continue;
            }

            if (isContainedInNearbyLonger(current, currentNormalized, currentWordCount, rows, i)) {
                continue;
            }
            collapsed.add(current);
        }
        return collapsed;
    }

    private boolean isContainedInNearbyLonger(
            RawTranscriptCandidate current,
            String currentNormalized,
            int currentWordCount,
            List<RawTranscriptCandidate> rows,
            int index
    ) {
        for (int i = 0; i < rows.size(); i++) {
            if (i == index) {
                continue;
            }
            RawTranscriptCandidate other = rows.get(i);
            if (!isWithinReadableWindow(other, current)) {
                continue;
            }
            String otherNormalized = normalizeTranscriptForCompare(other.rawText());
            int otherWordCount = normalizedTokenCount(otherNormalized);
            if (otherWordCount < 4 || otherWordCount <= currentWordCount) {
                continue;
            }
            if (currentWordCount > READABLE_TINY_FRAGMENT_MAX_WORDS
                    && otherWordCount > currentWordCount + 6) {
                continue;
            }
            if (otherNormalized.contains(currentNormalized)) {
                return true;
            }
        }
        return false;
    }

    private List<RawTranscriptCandidate> mergeCandidatesIntoBlocks(List<RawTranscriptCandidate> rows) {
        if (rows.isEmpty()) {
            return List.of();
        }

        List<RawTranscriptCandidate> blocks = new ArrayList<>();
        RawTranscriptCandidate block = rows.get(0);
        for (int i = 1; i < rows.size(); i++) {
            RawTranscriptCandidate next = rows.get(i);
            if (!canMergeIntoBlock(block, next)) {
                blocks.add(block);
                block = next;
                continue;
            }
            block = mergeIntoBlock(block, next);
        }
        blocks.add(block);
        return blocks;
    }

    private boolean canMergeIntoBlock(RawTranscriptCandidate currentBlock, RawTranscriptCandidate next) {
        double blockStart = currentBlock.startTimeSeconds();
        double blockEnd = resolveEnd(currentBlock.startTimeSeconds(), currentBlock.endTimeSeconds());
        double nextStart = next.startTimeSeconds();
        double nextEnd = resolveEnd(next.startTimeSeconds(), next.endTimeSeconds());

        boolean nearOrOverlap = nextStart <= blockEnd + APPENDIX_MERGE_GAP_SECONDS;
        if (!nearOrOverlap) {
            return false;
        }

        boolean speakerCompatible = hasSpeakerContinuity(currentBlock.speaker(), next.speaker())
                || Math.abs(nextStart - blockEnd) <= 1.0d;
        if (!speakerCompatible) {
            return false;
        }

        double mergedDuration = Math.max(blockEnd, nextEnd) - Math.min(blockStart, nextStart);
        if (mergedDuration > APPENDIX_MAX_BLOCK_SECONDS) {
            return false;
        }

        String mergedText = appendRawText(currentBlock.rawText(), next.rawText());
        return mergedText.length() <= APPENDIX_MAX_BLOCK_CHARS;
    }

    private RawTranscriptCandidate mergeIntoBlock(RawTranscriptCandidate block, RawTranscriptCandidate next) {
        double mergedStart = Math.min(block.startTimeSeconds(), next.startTimeSeconds());
        double mergedEnd = Math.max(resolveEnd(block.startTimeSeconds(), block.endTimeSeconds()),
                resolveEnd(next.startTimeSeconds(), next.endTimeSeconds()));
        String mergedSpeaker = mergeSpeakerLabels(block.speaker(), next.speaker());
        String mergedText = appendRawText(block.rawText(), next.rawText());
        return new RawTranscriptCandidate(mergedStart, mergedEnd, mergedSpeaker, mergedText);
    }

    private boolean hasSpeakerContinuity(String left, String right) {
        if (left == null || right == null) {
            return true;
        }
        if ("N/A".equalsIgnoreCase(left) || "N/A".equalsIgnoreCase(right)) {
            return true;
        }
        String[] leftParts = left.split("/");
        String[] rightParts = right.split("/");
        for (String lp : leftParts) {
            String normalizedLeft = lp.trim();
            for (String rp : rightParts) {
                String normalizedRight = rp.trim();
                if (!normalizedLeft.isBlank() && normalizedLeft.equalsIgnoreCase(normalizedRight)) {
                    return true;
                }
            }
        }
        return false;
    }

    private String mergeSpeakerLabels(String left, String right) {
        if (left == null || left.isBlank() || "N/A".equalsIgnoreCase(left)) {
            return safeCell(right);
        }
        if (right == null || right.isBlank() || "N/A".equalsIgnoreCase(right)) {
            return safeCell(left);
        }
        if (left.equalsIgnoreCase(right)) {
            return left;
        }
        LinkedHashSet<String> merged = new LinkedHashSet<>();
        for (String part : left.split("/")) {
            String value = part.trim();
            if (!value.isBlank()) {
                merged.add(value);
            }
        }
        for (String part : right.split("/")) {
            String value = part.trim();
            if (!value.isBlank()) {
                merged.add(value);
            }
        }
        return String.join("/", merged);
    }

    private String appendRawText(String current, String next) {
        String left = current == null ? "" : current.trim();
        String right = next == null ? "" : next.trim();
        if (left.isBlank()) {
            return right;
        }
        if (right.isBlank()) {
            return left;
        }

        String normalizedLeft = normalizeTranscriptForCompare(left);
        String normalizedRight = normalizeTranscriptForCompare(right);
        if (normalizedLeft.equals(normalizedRight)) {
            return left.length() >= right.length() ? left : right;
        }
        if (normalizedLeft.contains(normalizedRight)) {
            return left;
        }
        if (normalizedRight.contains(normalizedLeft)) {
            return right;
        }
        return left + " " + right;
    }

    private String normalizeTranscriptForCompare(String value) {
        if (value == null) {
            return "";
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        normalized = normalized.replaceAll("[\\p{Punct}]+", " ");
        return normalized.replaceAll("\\s+", " ").trim();
    }

    private boolean isWithinReadableWindow(RawTranscriptCandidate left, RawTranscriptCandidate right) {
        double leftStart = left.startTimeSeconds();
        double leftEnd = resolveEnd(left.startTimeSeconds(), left.endTimeSeconds());
        double rightStart = right.startTimeSeconds();
        double rightEnd = resolveEnd(right.startTimeSeconds(), right.endTimeSeconds());
        if (leftStart <= rightEnd && rightStart <= leftEnd) {
            return true;
        }
        double gapSeconds = leftEnd < rightStart ? rightStart - leftEnd : leftStart - rightEnd;
        return gapSeconds <= READABLE_DUPLICATE_WINDOW_SECONDS;
    }

    private double parseTimeSeconds(Object... values) {
        String raw = firstNonBlank(values);
        if (raw.isBlank()) {
            return 0d;
        }
        try {
            return Math.max(0d, Double.parseDouble(raw));
        } catch (NumberFormatException ex) {
            return 0d;
        }
    }

    private double resolveEnd(double start, double end) {
        return end >= start ? end : start;
    }

    private String formatTranscriptTime(double seconds) {
        long totalSeconds = Math.max(0L, Math.round(seconds));
        long hours = totalSeconds / 3600L;
        long minutes = (totalSeconds % 3600L) / 60L;
        long secs = totalSeconds % 60L;
        if (hours > 0L) {
            return String.format(Locale.ROOT, "%02d:%02d:%02d", hours, minutes, secs);
        }
        return String.format(Locale.ROOT, "%02d:%02d", minutes, secs);
    }

    private String detectTranscriptLanguage(List<Map<String, Object>> transcriptRows) {
        if (transcriptRows == null || transcriptRows.isEmpty()) {
            return "Unknown";
        }

        StringBuilder transcriptBuilder = new StringBuilder();
        for (Map<String, Object> row : transcriptRows) {
            if (row == null) {
                continue;
            }
            Object text = row.get("text");
            if (text != null) {
                transcriptBuilder.append(String.valueOf(text)).append(' ');
            }
        }
        String transcript = transcriptBuilder.toString().trim();
        if (transcript.isBlank()) {
            return "Unknown";
        }

        int englishScore = scoreEnglish(transcript);
        int vietnameseScore = scoreVietnamese(transcript);
        if (englishScore < 3 && vietnameseScore < 3) {
            return "Unknown";
        }
        if (englishScore >= 3 && vietnameseScore >= 3) {
            return "Mixed";
        }
        if (englishScore >= Math.max(3, vietnameseScore * 2)) {
            return "English";
        }
        if (vietnameseScore >= Math.max(3, englishScore * 2)) {
            return "Vietnamese";
        }
        if (englishScore > 0 && vietnameseScore > 0) {
            return "Mixed";
        }
        return englishScore > 0 ? "English" : "Vietnamese";
    }

    private int scoreEnglish(String transcript) {
        if (transcript == null || transcript.isBlank()) {
            return 0;
        }
        String normalized = transcript.toLowerCase(Locale.ROOT);
        String[] tokens = normalized.split("[^a-z]+");
        if (tokens.length == 0) {
            return 0;
        }
        Set<String> commonWords = Set.of(
                "the", "and", "to", "of", "in", "for", "on", "with", "we", "you",
                "is", "are", "this", "that", "it", "as", "at", "be", "from", "by"
        );
        int asciiWordCount = 0;
        int commonWordHits = 0;
        for (String token : tokens) {
            if (token.length() < 2) {
                continue;
            }
            asciiWordCount += 1;
            if (commonWords.contains(token)) {
                commonWordHits += 1;
            }
        }
        return commonWordHits * 3 + Math.min(20, asciiWordCount / 6);
    }

    private int scoreVietnamese(String transcript) {
        if (transcript == null || transcript.isBlank()) {
            return 0;
        }
        String lower = transcript.toLowerCase(Locale.ROOT);
        int diacriticHits = 0;
        String vietnameseDiacritics = "ăâđêôơưáàảãạắằẳẵặấầẩẫậéèẻẽẹếềểễệíìỉĩịóòỏõọốồổỗộớờởỡợúùủũụứừửữựýỳỷỹỵ";
        for (int i = 0; i < lower.length(); i++) {
            if (vietnameseDiacritics.indexOf(lower.charAt(i)) >= 0) {
                diacriticHits += 1;
            }
        }
        int commonWordHits = 0;
        Set<String> commonWords = Set.of(
                "và", "là", "của", "cho", "không", "được", "trong", "với", "những", "chúng",
                "tôi", "bạn", "anh", "chị", "đã", "đang", "sẽ", "này", "đó", "một"
        );
        for (String token : lower.split("[^\\p{L}]+")) {
            if (commonWords.contains(token)) {
                commonWordHits += 1;
            }
        }
        return diacriticHits * 2 + commonWordHits * 3;
    }

    private List<MeetingReportData.AnalyzedHighlightRow> buildAnalyzedHighlights(
            String summary,
            List<String> decisions,
            List<MeetingReportData.ReportActionItem> actionItems,
            List<String> risks,
            List<String> blockers,
            List<String> questions,
            List<String> nextSteps
    ) {
        List<MeetingReportData.AnalyzedHighlightRow> rows = new ArrayList<>();
        int index = 1;

        if (summary != null && !summary.isBlank() && !"Analysis not available".equals(summary) && !"N/A".equals(summary)) {
            rows.add(new MeetingReportData.AnalyzedHighlightRow(
                    index++,
                    "Summary",
                    summary,
                    "N/A",
                    "N/A",
                    "N/A"
            ));
        }

        index = appendStringHighlights(rows, index, "Decision", decisions);
        index = appendActionItemHighlights(rows, index, actionItems);
        index = appendStringHighlights(rows, index, "Risk", risks);
        index = appendStringHighlights(rows, index, "Blocker", blockers);
        index = appendStringHighlights(rows, index, "Question", questions);
        appendStringHighlights(rows, index, "Next Step", nextSteps);

        if (rows.size() > MAX_REPORT_HIGHLIGHT_ROWS) {
            return List.copyOf(rows.subList(0, MAX_REPORT_HIGHLIGHT_ROWS));
        }
        return rows;
    }

    private List<MeetingReportData.ReportActionItem> extractReportActionItems(Map<String, Object> analysisPayload) {
        Object raw = analysisPayload.get("businessActionItems");
        if (!(raw instanceof List<?>)) {
            raw = analysisPayload.get("action_items");
        }
        if (!(raw instanceof List<?>)) {
            raw = analysisPayload.get("actionItems");
        }
        if (!(raw instanceof List<?> items) || items.isEmpty()) {
            return List.of();
        }

        List<MeetingReportData.ReportActionItem> results = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Object item : items) {
            String task = "";
            String owner = "";
            String dueDate = "";
            String evidence = "";

            if (item instanceof Map<?, ?> map) {
                task = firstNonBlank(map.get("task"), map.get("description"), map.get("text"), map.get("title"));
                owner = firstNonBlank(map.get("owner"));
                dueDate = firstNonBlank(map.get("dueDate"), map.get("due_date"), map.get("deadline"));
                evidence = firstNonBlank(map.get("evidence"));
            } else if (item != null) {
                task = String.valueOf(item).trim();
            }

            if (task.isBlank()) {
                continue;
            }
            String key = task.toLowerCase(Locale.ROOT);
            if (seen.contains(key)) {
                continue;
            }
            seen.add(key);
            results.add(new MeetingReportData.ReportActionItem(
                    task,
                    safeCell(owner),
                    safeCell(dueDate),
                    safeCell(evidence)
            ));
        }
        return results;
    }

    private List<String> extractTechnicalTerms(Map<String, Object> analysisPayload) {
        Object raw = analysisPayload.get("technicalTerms");
        if (!(raw instanceof List<?>)) {
            raw = analysisPayload.get("technical_terms");
        }
        if (!(raw instanceof List<?> terms) || terms.isEmpty()) {
            return List.of();
        }
        List<String> results = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Object item : terms) {
            String text;
            if (item instanceof Map<?, ?> map) {
                String term = firstNonBlank(map.get("term"), map.get("title"), map.get("name"));
                String meaning = firstNonBlank(map.get("meaning"), map.get("description"));
                text = meaning.isBlank() ? term : term + " - " + meaning;
            } else {
                text = item == null ? "" : String.valueOf(item).trim();
            }
            if (text.isBlank()) {
                continue;
            }
            String key = text.toLowerCase(Locale.ROOT);
            if (seen.add(key)) {
                results.add(text);
            }
        }
        return results;
    }

    private List<String> extractStringList(Map<String, Object> payload, String... keys) {
        for (String key : keys) {
            Object value = payload.get(key);
            if (!(value instanceof List<?> list) || list.isEmpty()) {
                continue;
            }
            List<String> normalized = new ArrayList<>();
            Set<String> seen = new LinkedHashSet<>();
            for (Object item : list) {
                String text = item == null ? "" : String.valueOf(item).trim();
                if (text.isBlank()) {
                    continue;
                }
                String lowered = text.toLowerCase(Locale.ROOT);
                if (seen.contains(lowered)) {
                    continue;
                }
                seen.add(lowered);
                normalized.add(text);
            }
            if (!normalized.isEmpty()) {
                return normalized;
            }
        }
        return List.of();
    }

    private String resolveSummary(Map<String, Object> analysisPayload, boolean analysisAvailable) {
        String summary = firstNonBlank(
                analysisPayload.get("meetingSummary"),
                analysisPayload.get("summary")
        );
        if (!summary.isBlank()) {
            return summary;
        }
        return analysisAvailable ? "N/A" : "Analysis not available";
    }

    private String resolveAnalysisMetadataStatus(
            Map<String, Object> analysisPayload,
            Map<String, Object> state,
            boolean analysisAvailable
    ) {
        String status = firstNonBlank(
                analysisPayload.get("analysisStatus"),
                analysisPayload.get("analysis_status"),
                analysisPayload.get("status")
        );
        if (status.isBlank() && analysisAvailable && state != null) {
            status = firstNonBlank(
                    state.get("analysisStatus"),
                    state.get("analysis_status"),
                    state.get("status")
            );
        }
        return status.isBlank() ? "" : status;
    }

    private boolean hasAnalysisCacheMetadata(Map<String, Object> analysisPayload) {
        if (analysisPayload == null || analysisPayload.isEmpty()) {
            return false;
        }
        return !firstNonBlank(
                analysisPayload.get("analysisStatus"),
                analysisPayload.get("analysis_status"),
                analysisPayload.get("cacheHit"),
                analysisPayload.get("stale"),
                analysisPayload.get("staleReason"),
                analysisPayload.get("provider"),
                analysisPayload.get("model"),
                analysisPayload.get("canonicalTranscriptHash"),
                analysisPayload.get("canonical_transcript_hash"),
                analysisPayload.get("canonicalTranscriptVersion"),
                analysisPayload.get("canonical_transcript_version"),
                analysisPayload.get("analysisInputMode"),
                analysisPayload.get("analysis_input_mode"),
                analysisPayload.get("lastAnalyzedAt")
        ).isBlank();
    }

    private String resolveAnalysisMetadataSource(
            Map<String, Object> analysisPayload,
            String promptVersion,
            String schemaVersion,
            boolean analysisAvailable
    ) {
        String source = firstNonBlank(
                analysisPayload.get("source"),
                analysisPayload.get("provider"),
                analysisPayload.get("analysisProvider"),
                analysisPayload.get("analysis_provider")
        );
        if (!source.isBlank()) {
            return source;
        }
        if (!analysisAvailable) {
            return "";
        }
        String metadata = (firstNonBlank(promptVersion) + " " + firstNonBlank(schemaVersion)).toLowerCase(Locale.ROOT);
        if (metadata.contains("gemini")) {
            return "gemini";
        }
        return "";
    }

    private String firstNonBlank(Object... values) {
        if (values == null) {
            return "";
        }
        for (Object value : values) {
            if (value == null) {
                continue;
            }
            String text = String.valueOf(value).trim();
            if (!text.isBlank()) {
                return text;
            }
        }
        return "";
    }

    private String safeCell(Object value) {
        String text = firstNonBlank(value);
        return text.isBlank() ? "N/A" : text;
    }

    private int appendStringHighlights(
            List<MeetingReportData.AnalyzedHighlightRow> rows,
            int index,
            String category,
            List<String> values
    ) {
        if (values == null || values.isEmpty()) {
            return index;
        }
        for (String value : values) {
            if (rows.size() >= MAX_REPORT_HIGHLIGHT_ROWS) {
                return index;
            }
            rows.add(new MeetingReportData.AnalyzedHighlightRow(
                    index++,
                    category,
                    safeCell(value),
                    "N/A",
                    "N/A",
                    "N/A"
            ));
        }
        return index;
    }

    private int appendActionItemHighlights(
            List<MeetingReportData.AnalyzedHighlightRow> rows,
            int index,
            List<MeetingReportData.ReportActionItem> actionItems
    ) {
        if (actionItems == null || actionItems.isEmpty()) {
            return index;
        }
        for (MeetingReportData.ReportActionItem actionItem : actionItems) {
            if (rows.size() >= MAX_REPORT_HIGHLIGHT_ROWS) {
                return index;
            }
            rows.add(new MeetingReportData.AnalyzedHighlightRow(
                    index++,
                    "Action Item",
                    safeCell(actionItem.task()),
                    safeCell(actionItem.owner()),
                    safeCell(actionItem.dueDate()),
                    safeCell(actionItem.evidence())
            ));
        }
        return index;
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
            mergeAnalysisFailureMetadata(response, analysisState);
            return response;
        }

        if (analysisState != null && analysisState.isFailed()) {
            if (analysisState.retryAfterSeconds() > 0 || AnalysisFailureMapping.isRetryableErrorCode(analysisState.errorCode())) {
                return buildAnalysisFailureResponse(meetingId, stateStatus, analysisState);
            }
        }

        if (isFailedAudioCaptureStatus(stateStatus)) {
            log.info(
                    "event=ANALYSIS_TRIGGER_SKIPPED meetingId={} source={} reason=failed_audio_capture transcriptRows=0",
                    meetingId,
                    REALTIME_ANALYSIS_SOURCE_GET_ANALYSIS_LAZY
            );
            return buildFailedAudioCaptureAnalysisResponse(meetingId);
        }

        if (isNoTranscriptAfterFinalizeStatus(stateStatus)) {
            log.info(
                    "event=ANALYSIS_TRIGGER_SKIPPED meetingId={} source={} reason=no_transcript_after_finalize transcriptRows=0",
                    meetingId,
                    REALTIME_ANALYSIS_SOURCE_GET_ANALYSIS_LAZY
            );
            return buildNoTranscriptAfterFinalizeAnalysisResponse(meetingId);
        }

        AnalysisTriggerResult triggerResult = maybeTriggerRealtimeAnalysisLazy(meetingId, traceId, authorization, state);
        if ("FAILED".equals(triggerResult.status()) && triggerResult.errorCode() != null && !triggerResult.errorCode().isBlank()) {
            if (AnalysisFailureMapping.isRetryableErrorCode(triggerResult.errorCode())) {
                JobStateStore.AnalysisStateSnapshot retryableState = jobStateStore.getAnalysisState(meetingId).orElse(analysisState);
                return buildAnalysisFailureResponse(meetingId, stateStatus, retryableState);
            }
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
        mergeAnalysisFailureMetadata(response, analysisState);
        if (analysisState == null && triggerResult.retryAfterSeconds() > 0) {
            response.put("retryAfterSeconds", triggerResult.retryAfterSeconds());
        }
        return response;
    }

    private Map<String, Object> buildAnalysisFailureResponse(
            Long meetingId,
            String stateStatus,
            JobStateStore.AnalysisStateSnapshot analysisState
    ) {
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        String analysisStatus = analysisState != null && AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE.equals(analysisState.status())
                ? AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE
                : "FAILED";
        response.put("status", analysisStatus);
        response.put("analysisStatus", analysisStatus);
        mergeAnalysisFailureMetadata(response, analysisState);
        response.put("transcriptSaved", true);
        return response;
    }

    private void mergeAnalysisFailureMetadata(
            Map<String, Object> response,
            JobStateStore.AnalysisStateSnapshot analysisState
    ) {
        if (analysisState == null) {
            return;
        }
        if (AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE.equals(analysisState.status())) {
            response.put("status", AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE);
            response.put("analysisStatus", AnalysisFailureMapping.ANALYSIS_STATUS_FAILED_RETRYABLE);
        } else if (analysisState.status() != null && !analysisState.status().isBlank()) {
            response.put("analysisStatus", analysisState.status());
        }
        if (analysisState.retryAfterSeconds() > 0) {
            response.put("retryAfterSeconds", analysisState.retryAfterSeconds());
        }
        if (analysisState.errorCode() != null && !analysisState.errorCode().isBlank()) {
            response.put("errorCode", analysisState.errorCode());
        }
        response.put("retryable", analysisState.retryable());
        response.put("retryExhausted", analysisState.retryExhausted());
        if (analysisState.analysisRetryCount() > 0) {
            response.put("analysisRetryCount", analysisState.analysisRetryCount());
        }
        if (analysisState.analysisNextRetryAt() != null && !analysisState.analysisNextRetryAt().isBlank()) {
            response.put("analysisNextRetryAt", analysisState.analysisNextRetryAt());
        }
        if (analysisState.analysisTraceId() != null && !analysisState.analysisTraceId().isBlank()) {
            response.put("analysisTraceId", analysisState.analysisTraceId());
        }
        if (analysisState.analysisProviderAlias() != null && !analysisState.analysisProviderAlias().isBlank()) {
            response.put("analysisProviderAlias", analysisState.analysisProviderAlias());
        }
        if (analysisState.errorMessage() != null && !analysisState.errorMessage().isBlank()) {
            response.put("errorMessage", analysisState.errorMessage());
        }
    }

    private JobStateStore.AnalysisRetryMetadata extractAnalysisRetryMetadata(Map<String, Object> response) {
        if (response == null || response.isEmpty()) {
            return JobStateStore.AnalysisRetryMetadata.empty();
        }
        boolean retryExhausted = parseBooleanResponseField(response, "retryExhausted", "retry_exhausted");
        int analysisRetryCount = parseIntResponseField(response, "analysisRetryCount", "analysis_retry_count");
        String analysisNextRetryAt = firstResponseString(response, "analysisNextRetryAt", "analysis_next_retry_at");
        String analysisTraceId = firstResponseString(response, "analysisTraceId", "analysis_trace_id");
        String analysisProviderAlias = firstResponseString(response, "analysisProviderAlias", "analysis_provider_alias");
        return new JobStateStore.AnalysisRetryMetadata(
                retryExhausted,
                analysisRetryCount,
                analysisNextRetryAt,
                analysisTraceId,
                analysisProviderAlias
        );
    }

    private boolean parseBooleanResponseField(Map<String, Object> response, String... keys) {
        for (String key : keys) {
            Object value = response.get(key);
            if (value == null) {
                continue;
            }
            if (value instanceof Boolean boolValue) {
                return boolValue;
            }
            String normalized = String.valueOf(value).trim().toLowerCase();
            if ("true".equals(normalized) || "1".equals(normalized)) {
                return true;
            }
            if ("false".equals(normalized) || "0".equals(normalized)) {
                return false;
            }
        }
        return false;
    }

    private int parseIntResponseField(Map<String, Object> response, String... keys) {
        for (String key : keys) {
            Object value = response.get(key);
            if (value == null) {
                continue;
            }
            if (value instanceof Number numberValue) {
                return numberValue.intValue();
            }
            try {
                return Integer.parseInt(String.valueOf(value).trim());
            } catch (NumberFormatException ignored) {
                continue;
            }
        }
        return 0;
    }

    private String firstResponseString(Map<String, Object> response, String... keys) {
        for (String key : keys) {
            Object value = response.get(key);
            if (value == null) {
                continue;
            }
            String normalized = String.valueOf(value).trim();
            if (!normalized.isBlank() && !"null".equalsIgnoreCase(normalized)) {
                return normalized;
            }
        }
        return null;
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

    private boolean isNoTranscriptAfterFinalizeStatus(String status) {
        return RealtimeStatusCodes.isNoTranscriptTerminal(status);
    }

    private boolean isFailedAudioCaptureStatus(String status) {
        return RealtimeStatusCodes.FAILED_AUDIO_CAPTURE.equals(RealtimeStatusCodes.normalize(status));
    }

    private void annotateNoTranscriptAfterFinalize(Map<String, Object> response, String status) {
        if (isFailedAudioCaptureStatus(status)) {
            response.put("status", RealtimeStatusCodes.FAILED_AUDIO_CAPTURE);
            response.put("errorCode", RealtimeStatusCodes.FAILED_AUDIO_CAPTURE);
            response.put("analysisStatus", ANALYSIS_STATUS_NO_ANALYSIS);
            response.put("transcriptRows", 0);
            response.put("finalized", true);
            return;
        }
        if (!isNoTranscriptAfterFinalizeStatus(status)) {
            return;
        }

        response.put("status", RealtimeStatusCodes.NO_TRANSCRIPT);
        response.put("errorCode", RealtimeStatusCodes.NO_TRANSCRIPT);
        response.put("legacyErrorCode", RealtimeStatusCodes.legacyNoTranscriptAlias());
        response.put("analysisStatus", ANALYSIS_STATUS_NO_ANALYSIS);
        response.put("transcriptRows", 0);
        response.put("finalized", true);
    }

    private Map<String, Object> buildNoTranscriptAfterFinalizeAnalysisResponse(Long meetingId) {
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        response.put("status", RealtimeStatusCodes.NO_TRANSCRIPT);
        response.put("analysisStatus", ANALYSIS_STATUS_NO_ANALYSIS);
        response.put("errorCode", RealtimeStatusCodes.NO_TRANSCRIPT);
        response.put("legacyErrorCode", RealtimeStatusCodes.legacyNoTranscriptAlias());
        response.put("transcriptRows", 0);
        response.put("finalized", true);
        return response;
    }

    private Map<String, Object> buildFailedAudioCaptureAnalysisResponse(Long meetingId) {
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        response.put("status", RealtimeStatusCodes.FAILED_AUDIO_CAPTURE);
        response.put("analysisStatus", ANALYSIS_STATUS_NO_ANALYSIS);
        response.put("errorCode", RealtimeStatusCodes.FAILED_AUDIO_CAPTURE);
        response.put("transcriptRows", 0);
        response.put("finalized", true);
        return response;
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

    private Map<String, Object> fetchAccessibleMeeting(Long meetingId, String traceId, String authorization) {
        if (authorization == null || authorization.isBlank()) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Missing authorization");
        }
        try {
            return meetingServiceClient.getMeetingById(meetingId, traceId, authorization);
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

    private void assertMeetingAccess(Long meetingId, String traceId, String authorization) {
        fetchAccessibleMeeting(meetingId, traceId, authorization);
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

    private TranscriptPayload buildStateTranscriptPayload(Map<String, Object> state) {
        List<Map<String, Object>> stateTranscriptRows = extractTranscriptRowsFromState(state);
        if (stateTranscriptRows.isEmpty()) {
            return TranscriptPayload.empty();
        }
        return new TranscriptPayload(
                stateTranscriptRows,
                stateTranscriptRows,
                TRANSCRIPT_MODE_RAW,
                null,
                null,
                null
        );
    }

    private TranscriptPayload normalizeTranscriptPayload(Map<String, Object> payload) {
        if (payload == null || payload.isEmpty()) {
            return TranscriptPayload.empty();
        }

        List<Map<String, Object>> readableRows = normalizeTranscriptRows(payload.get("transcripts"));
        List<Map<String, Object>> rawRows = normalizeTranscriptRows(
                payload.containsKey("rawTranscripts")
                        ? payload.get("rawTranscripts")
                        : payload.get("raw_transcripts")
        );
        if (rawRows.isEmpty()) {
            rawRows = readableRows;
        }
        if (readableRows.isEmpty() && !rawRows.isEmpty()) {
            readableRows = rawRows;
        }

        String canonicalVersion = firstNonBlank(
                payload.get("canonicalTranscriptVersion"),
                payload.get("canonical_transcript_version")
        );
        String canonicalHash = firstNonBlank(
                payload.get("canonicalTranscriptHash"),
                payload.get("canonical_transcript_hash")
        );
        String canonicalGeneratedAt = firstNonBlank(
                payload.get("canonicalGeneratedAt"),
                payload.get("canonical_generated_at")
        );

        String transcriptMode = firstNonBlank(
                payload.get("transcriptMode"),
                payload.get("transcript_mode")
        ).toLowerCase(Locale.ROOT);
        if (transcriptMode.isBlank()) {
            transcriptMode = (!canonicalVersion.isBlank() || !canonicalHash.isBlank()) && !readableRows.isEmpty()
                    ? TRANSCRIPT_MODE_CANONICAL
                    : TRANSCRIPT_MODE_RAW;
        } else if (!TRANSCRIPT_MODE_CANONICAL.equals(transcriptMode)) {
            transcriptMode = TRANSCRIPT_MODE_RAW;
        }

        return new TranscriptPayload(
                readableRows,
                rawRows,
                transcriptMode,
                canonicalVersion.isBlank() ? null : canonicalVersion,
                canonicalHash.isBlank() ? null : canonicalHash,
                canonicalGeneratedAt.isBlank() ? null : canonicalGeneratedAt
        );
    }

    private Map<String, Object> buildTranscriptResponse(
            Long meetingId,
            String status,
            TranscriptPayload payload
    ) {
        StabilizedTranscriptResult stabilizedTranscript = stabilizeReadableTranscriptRows(payload.readableRows());
        Map<String, Object> response = new HashMap<>();
        response.put("meeting_id", meetingId);
        response.put("status", status);
        response.put("transcripts", stabilizedTranscript.rows());
        response.put("transcriptMode", payload.transcriptMode());
        if (stabilizedTranscript.stabilizationVersion() != null) {
            response.put("speakerStabilizationVersion", stabilizedTranscript.stabilizationVersion());
        }
        if (stabilizedTranscript.speakerStats() != null && !stabilizedTranscript.speakerStats().isEmpty()) {
            response.put("speakerStats", stabilizedTranscript.speakerStats());
        }

        if (payload.isCanonicalMode()) {
            if (payload.canonicalTranscriptVersion() != null) {
                response.put("canonicalTranscriptVersion", payload.canonicalTranscriptVersion());
            }
            if (payload.canonicalTranscriptHash() != null) {
                response.put("canonicalTranscriptHash", payload.canonicalTranscriptHash());
            }
            if (payload.canonicalGeneratedAt() != null) {
                response.put("canonicalGeneratedAt", payload.canonicalGeneratedAt());
            }
            if (!payload.rawRows().isEmpty()) {
                response.put("rawTranscripts", payload.rawRows());
                response.put("raw_transcripts", payload.rawRows());
            }
        }

        return response;
    }

    private TranscriptSourceDecision loadReadableTranscriptSourceForSearch(Long meetingId, String traceId) {
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        TranscriptPayload stateTranscriptPayload = buildStateTranscriptPayload(state);
        TranscriptPayload aiTranscriptPayload = fetchTranscriptPayloadFromAiService(meetingId, traceId);
        return selectReadableTranscriptSource(stateTranscriptPayload, aiTranscriptPayload);
    }

    private TranscriptPayload loadSavedTranscriptPayloadForExport(
            Long meetingId,
            String traceId,
            String authorization,
            boolean required,
            TranscriptExportMode exportMode
    ) {
        assertMeetingAccess(meetingId, traceId, authorization);
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        TranscriptPayload statePayload = buildStateTranscriptPayload(state);
        boolean shouldFetchPersisted = exportMode == TranscriptExportMode.READABLE || statePayload.rawRows().isEmpty();
        TranscriptPayload persistedTranscriptPayload = shouldFetchPersisted
                ? fetchPersistedTranscriptPayloadForExport(meetingId, traceId)
                : TranscriptPayload.empty();
        TranscriptSourceDecision decision = exportMode == TranscriptExportMode.READABLE
                ? selectReadableTranscriptSource(statePayload, persistedTranscriptPayload)
                : selectRawTranscriptSource(statePayload, persistedTranscriptPayload);

        if (!decision.payload().readableRows().isEmpty()) {
            log.info(
                    "TRANSCRIPT_EXPORT_SOURCE meetingId={} mode={} source={} rows={}",
                    meetingId,
                    exportMode == TranscriptExportMode.READABLE ? "readable" : "raw",
                    decision.source(),
                    decision.payload().readableRows().size()
            );
            return decision.payload();
        }

        log.info("TRANSCRIPT_EXPORT_NOT_READY meetingId={}", meetingId);
        if (required) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Transcript is not ready yet.");
        }
        return TranscriptPayload.empty();
    }

    private TranscriptPayload loadSavedTranscriptPayloadForRerun(
            Long meetingId,
            String traceId,
            String authorization
    ) {
        Map<String, Object> state = jobStateStore.getJobState(meetingId).orElse(null);
        TranscriptPayload statePayload = buildStateTranscriptPayload(state);
        TranscriptPayload persistedPayload = fetchPersistedTranscriptPayloadForExport(meetingId, traceId);
        TranscriptSourceDecision decision = selectReadableTranscriptSource(statePayload, persistedPayload);
        log.info(
                "ANALYSIS_RERUN_TRANSCRIPT_SOURCE meetingId={} source={} rows={}",
                meetingId,
                decision.source(),
                decision.payload().readableRows().size()
        );
        return decision.payload();
    }

    private TranscriptSourceDecision selectReadableTranscriptSource(
            TranscriptPayload statePayload,
            TranscriptPayload persistedPayload
    ) {
        if (persistedPayload.isCanonicalMode() && !persistedPayload.readableRows().isEmpty()) {
            return new TranscriptSourceDecision(persistedPayload, "ai_persisted_canonical");
        }
        if (!statePayload.rawRows().isEmpty()) {
            return new TranscriptSourceDecision(statePayload, "processing_job_state");
        }
        if (!persistedPayload.readableRows().isEmpty()) {
            return new TranscriptSourceDecision(persistedPayload, "ai_persisted_transcript");
        }
        return new TranscriptSourceDecision(TranscriptPayload.empty(), "none");
    }

    private TranscriptSourceDecision selectRawTranscriptSource(
            TranscriptPayload statePayload,
            TranscriptPayload persistedPayload
    ) {
        if (!statePayload.rawRows().isEmpty()) {
            return new TranscriptSourceDecision(statePayload, "processing_job_state");
        }
        if (!persistedPayload.rawRows().isEmpty()) {
            return new TranscriptSourceDecision(persistedPayload, "ai_persisted_transcript");
        }
        return new TranscriptSourceDecision(TranscriptPayload.empty(), "none");
    }

    private TranscriptPayload fetchPersistedTranscriptPayloadForExport(Long meetingId, String traceId) {
        try {
            // This endpoint reads persisted transcript rows only; it does not trigger STT/processing start.
            Map<String, Object> aiResponse = aiServiceClient.getTranscript(meetingId, traceId);
            return normalizeTranscriptPayload(aiResponse);
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                return TranscriptPayload.empty();
            }
            throw ex;
        }
    }

    private List<Map<String, Object>> sortTranscriptRowsForExport(List<Map<String, Object>> transcriptRows) {
        return sortTranscriptRowsByTimeline(transcriptRows);
    }

    private boolean hasTranscriptTiming(Map<String, Object> row) {
        if (row == null) {
            return false;
        }
        return row.containsKey("start_time") || row.containsKey("startTime")
                || row.containsKey("start")
                || row.containsKey("end_time") || row.containsKey("endTime")
                || row.containsKey("end");
    }

    private String buildTranscriptTxt(
            Long meetingId,
            Map<String, Object> meeting,
            List<Map<String, Object>> savedTranscriptRows,
            List<MeetingReportData.RawTranscriptRow> transcriptRows,
            TranscriptExportMode exportMode
    ) {
        StringBuilder builder = new StringBuilder();
        String meetingTitle = safeCell(meeting.get("title"));
        if (meetingTitle.isBlank()) {
            meetingTitle = "Meeting #" + meetingId;
        }
        String recognitionMode = safeCell(meeting.get("language"));
        if (recognitionMode.isBlank()) {
            recognitionMode = "unknown";
        }

        builder.append("Meeting: ").append(meetingTitle).append('\n');
        builder.append("Transcript export mode: ")
                .append(exportMode == TranscriptExportMode.READABLE ? "readable" : "raw")
                .append('\n');
        builder.append("Recognition Mode: ").append(recognitionMode).append('\n');
        builder.append("Detected Transcript Language: ").append(detectTranscriptLanguage(savedTranscriptRows)).append('\n');
        builder.append("Generated At: ").append(Instant.now()).append('\n');
        builder.append('\n');

        if (exportMode == TranscriptExportMode.READABLE) {
            builder.append(READABLE_TRANSCRIPT_EXPORT_NOTE)
                    .append(" Raw export is available with mode=raw.")
                    .append('\n');
        } else {
            builder.append("Raw transcript export from saved STT output. May contain overlapping STT fragments.")
                    .append('\n');
        }
        builder.append('\n');

        for (MeetingReportData.RawTranscriptRow row : transcriptRows) {
            builder.append('[')
                    .append(rawText(row.startTime()))
                    .append('–')
                    .append(rawText(row.endTime()))
                    .append("] ")
                    .append(rawText(row.speaker()))
                    .append(": ")
                    .append(rawText(row.rawText()))
                    .append('\n');
        }

        return builder.toString();
    }

    private String buildTranscriptCsv(List<MeetingReportData.RawTranscriptRow> transcriptRows) {
        StringBuilder builder = new StringBuilder();
        builder.append("index,startTime,endTime,speaker,text\n");

        int index = 1;
        for (MeetingReportData.RawTranscriptRow row : transcriptRows) {
            builder.append(index++)
                    .append(',')
                    .append(csvEscape(rawText(row.startTime())))
                    .append(',')
                    .append(csvEscape(rawText(row.endTime())))
                    .append(',')
                    .append(csvEscape(rawText(row.speaker())))
                    .append(',')
                    .append(csvEscape(rawText(row.rawText())))
                    .append('\n');
        }

        return builder.toString();
    }

    private String rawText(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private String csvEscape(String value) {
        String safe = value == null ? "" : value;
        return "\"" + safe.replace("\"", "\"\"") + "\"";
    }

    private TranscriptPayload fetchTranscriptPayloadFromAiService(Long meetingId, String traceId) {
        try {
            Map<String, Object> aiResponse = aiServiceClient.getTranscript(meetingId, traceId);
            TranscriptPayload payload = normalizeTranscriptPayload(aiResponse);
            if (!payload.readableRows().isEmpty()) {
                log.info(
                        "[traceId={}] [jobId={}] ai-service transcript fallback rows={} mode={}",
                        traceId,
                        meetingId,
                        payload.readableRows().size(),
                        payload.transcriptMode()
                );
                return payload;
            }
            log.info(
                    "[traceId={}] [jobId={}] ai-service transcript fallback returned empty transcript list",
                    traceId,
                    meetingId
            );
            return TranscriptPayload.empty();
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                log.info(
                        "[traceId={}] [jobId={}] ai-service transcript fallback returned 404/no transcript",
                        traceId,
                        meetingId
                );
                return TranscriptPayload.empty();
            }
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=transcript_fallback httpStatus={} errorCode=DOWNSTREAM_HTTP_ERROR",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getStatusCode().value()
            );
            return TranscriptPayload.empty();
        } catch (Exception ex) {
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=transcript_fallback errorCode={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getClass().getSimpleName()
            );
            return TranscriptPayload.empty();
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

    private Map<String, Object> fetchSavedAnalysisCacheOnlyForReport(
            Long meetingId,
            String traceId,
            String authorization,
            TranscriptPayload transcriptPayload,
            List<Map<String, Object>> transcriptRows
    ) {
        String transcriptText = buildTranscriptText(transcriptRows);
        String transcriptHash = resolveReportTranscriptHash(transcriptPayload, transcriptText);
        String promptVersion = resolvePromptVersion(null);
        String schemaVersion = resolveSchemaVersion(null);
        if (transcriptText.isBlank()) {
            return buildReportAnalysisMetadata(
                    ANALYSIS_STATUS_NO_ANALYSIS,
                    false,
                    null,
                    transcriptHash,
                    transcriptPayload,
                    promptVersion,
                    schemaVersion,
                    null,
                    "empty_transcript"
            );
        }

        try {
            Map<String, Object> aiResponse = aiServiceClient.getSavedAnalysisCacheOnly(
                    meetingId,
                    transcriptText,
                    transcriptHash,
                    promptVersion,
                    schemaVersion,
                    traceId,
                    authorization
            );
            return normalizeCacheOnlyAnalysisResponse(
                    aiResponse,
                    transcriptHash,
                    transcriptPayload,
                    promptVersion,
                    schemaVersion
            );
        } catch (HttpStatusCodeException ex) {
            if (ex.getStatusCode().value() == HttpStatus.NOT_FOUND.value()) {
                return buildReportAnalysisMetadata(
                        ANALYSIS_STATUS_NO_ANALYSIS,
                        false,
                        null,
                        transcriptHash,
                        transcriptPayload,
                        promptVersion,
                        schemaVersion,
                        null,
                        null
                );
            }
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=report_cache_only httpStatus={} errorCode=DOWNSTREAM_HTTP_ERROR",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getStatusCode().value()
            );
            return buildReportAnalysisMetadata(
                    ANALYSIS_STATUS_NO_ANALYSIS,
                    false,
                    null,
                    transcriptHash,
                    transcriptPayload,
                    promptVersion,
                    schemaVersion,
                    ex.getStatusCode().value(),
                    "cache_only_unavailable"
            );
        } catch (Exception ex) {
            log.warn(
                    "event=AI_SERVICE_CALL_FAILED traceId={} requestId={} meetingId={} source=report_cache_only errorCode={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    ex.getClass().getSimpleName()
            );
            return buildReportAnalysisMetadata(
                    ANALYSIS_STATUS_NO_ANALYSIS,
                    false,
                    null,
                    transcriptHash,
                    transcriptPayload,
                    promptVersion,
                    schemaVersion,
                    null,
                    "cache_only_unavailable"
            );
        }
    }

    private Map<String, Object> normalizeCacheOnlyAnalysisResponse(
            Map<String, Object> aiResponse,
            String transcriptHash,
            TranscriptPayload transcriptPayload,
            String promptVersion,
            String schemaVersion
    ) {
        if (aiResponse == null || aiResponse.isEmpty()) {
            return buildReportAnalysisMetadata(
                    ANALYSIS_STATUS_NO_ANALYSIS,
                    false,
                    null,
                    transcriptHash,
                    transcriptPayload,
                    promptVersion,
                    schemaVersion,
                    null,
                    null
            );
        }

        Map<String, Object> payload = new HashMap<>();
        Object nestedAnalysis = aiResponse.get("analysis");
        if (nestedAnalysis instanceof Map<?, ?> nestedMap) {
            for (Map.Entry<?, ?> entry : nestedMap.entrySet()) {
                payload.put(String.valueOf(entry.getKey()), entry.getValue());
            }
        }

        copyAnalysisMetadata(aiResponse, payload);
        payload.putIfAbsent("transcriptHash", transcriptHash);
        payload.putIfAbsent("transcript_hash", transcriptHash);
        payload.putIfAbsent("promptVersion", promptVersion);
        payload.putIfAbsent("schemaVersion", schemaVersion);
        if (transcriptPayload != null) {
            if (transcriptPayload.canonicalTranscriptHash() != null) {
                payload.putIfAbsent("canonicalTranscriptHash", transcriptPayload.canonicalTranscriptHash());
            }
            if (transcriptPayload.canonicalTranscriptVersion() != null) {
                payload.putIfAbsent("canonicalTranscriptVersion", transcriptPayload.canonicalTranscriptVersion());
            }
        }
        payload.putIfAbsent("source", "export_report_cache_only");
        String analysisStatus = firstNonBlank(payload.get("analysisStatus"), payload.get("status"));
        if (analysisStatus.isBlank()) {
            payload.put("analysisStatus", hasStructuredAnalysis(payload) ? "COMPLETED" : ANALYSIS_STATUS_NO_ANALYSIS);
        }
        if (!hasStructuredAnalysis(payload) && "completed".equalsIgnoreCase(firstNonBlank(payload.get("status")))) {
            payload.put("analysisStatus", ANALYSIS_STATUS_NO_ANALYSIS);
        }
        return payload;
    }

    private void copyAnalysisMetadata(Map<String, Object> source, Map<String, Object> target) {
        for (String key : List.of(
                "status",
                "analysisStatus",
                "cacheHit",
                "stale",
                "staleReason",
                "provider",
                "model",
                "promptVersion",
                "schemaVersion",
                "transcript_hash",
                "transcriptHash",
                "canonicalTranscriptHash",
                "canonicalTranscriptVersion",
                "analysisInputMode",
                "lastAnalyzedAt",
                "retryAfterSeconds",
                "source",
                "reason",
                "errorCode"
        )) {
            if (source.containsKey(key) && source.get(key) != null) {
                target.put(key, source.get(key));
            }
        }
    }

    private Map<String, Object> buildReportAnalysisMetadata(
            String analysisStatus,
            boolean stale,
            String staleReason,
            String transcriptHash,
            TranscriptPayload transcriptPayload,
            String promptVersion,
            String schemaVersion,
            Object retryAfterSeconds,
            String reason
    ) {
        Map<String, Object> metadata = new HashMap<>();
        metadata.put("status", analysisStatus == null ? ANALYSIS_STATUS_NO_ANALYSIS : analysisStatus);
        metadata.put("analysisStatus", analysisStatus == null ? ANALYSIS_STATUS_NO_ANALYSIS : analysisStatus);
        metadata.put("cacheHit", false);
        metadata.put("stale", stale);
        if (staleReason != null && !staleReason.isBlank()) {
            metadata.put("staleReason", staleReason);
        }
        metadata.put("transcriptHash", transcriptHash);
        metadata.put("transcript_hash", transcriptHash);
        metadata.put("promptVersion", promptVersion);
        metadata.put("schemaVersion", schemaVersion);
        if (transcriptPayload != null) {
            if (transcriptPayload.canonicalTranscriptHash() != null) {
                metadata.put("canonicalTranscriptHash", transcriptPayload.canonicalTranscriptHash());
            }
            if (transcriptPayload.canonicalTranscriptVersion() != null) {
                metadata.put("canonicalTranscriptVersion", transcriptPayload.canonicalTranscriptVersion());
            }
            metadata.put("analysisInputMode", transcriptPayload.isCanonicalMode() ? "canonical" : "readable_fallback");
        }
        if (retryAfterSeconds != null) {
            metadata.put("retryAfterSeconds", retryAfterSeconds);
        }
        if (reason != null && !reason.isBlank()) {
            metadata.put("reason", reason);
        }
        metadata.put("source", "export_report_cache_only");
        return metadata;
    }

    private String resolveReportTranscriptHash(TranscriptPayload transcriptPayload, String transcriptText) {
        String canonicalHash = transcriptPayload == null ? "" : firstNonBlank(transcriptPayload.canonicalTranscriptHash());
        if (!canonicalHash.isBlank()) {
            return canonicalHash;
        }
        if (transcriptText == null || transcriptText.isBlank()) {
            return "";
        }
        return computeTranscriptHash(transcriptText);
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

        String stateStatus = state == null ? "NOT_FOUND" : normalizeStatus(state.get("status"));
        if (isFailedAudioCaptureStatus(stateStatus)) {
            log.info(
                    "event=ANALYSIS_TRIGGER_SKIPPED meetingId={} source={} reason=failed_audio_capture transcriptRows=0",
                    meetingId,
                    source
            );
            return new AnalysisTriggerResult(ANALYSIS_STATUS_NO_ANALYSIS, RealtimeStatusCodes.FAILED_AUDIO_CAPTURE, 0);
        }
        if (isNoTranscriptAfterFinalizeStatus(stateStatus)) {
            log.info(
                    "event=ANALYSIS_TRIGGER_SKIPPED meetingId={} source={} reason=no_transcript_after_finalize transcriptRows=0",
                    meetingId,
                    source
            );
            return new AnalysisTriggerResult(ANALYSIS_STATUS_NO_ANALYSIS, RealtimeStatusCodes.NO_TRANSCRIPT, 0);
        }

        TranscriptPayload statePayload = buildStateTranscriptPayload(state);
        TranscriptPayload persistedPayload = fetchTranscriptPayloadFromAiService(meetingId, traceId);
        TranscriptSourceDecision transcriptDecision = selectReadableTranscriptSource(statePayload, persistedPayload);
        List<Map<String, Object>> transcriptRows = transcriptDecision.payload().readableRows();

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
        String analysisCacheKey = buildAnalysisCacheKey(
                transcriptHash,
                promptVersion,
                schemaVersion,
                GROUPED_ACTION_PLAN_FEATURE_SET
        );
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
                    responseSchemaVersion,
                    GROUPED_ACTION_PLAN_FEATURE_SET
            );
            String status = normalizeStatus(response == null ? null : response.get("status"));
            String reason = normalizeRealtimeSkipReason(response);
            int retryAfter = parseRetryAfter(response);
            if ("FAILED".equals(status)) {
                String errorCode = mapRealtimeFailureCode(response);
                int retryAfterForFailure = AnalysisFailureMapping.resolveRetryAfterSeconds(errorCode, retryAfter);
                jobStateStore.markAnalysisFailed(
                        meetingId,
                        responseCacheKey,
                        source,
                        "processing_service_lazy_poll",
                        lockToken,
                        errorCode,
                        safeErrorText(response.get("reason")),
                        retryAfterForFailure,
                        extractAnalysisRetryMetadata(response)
                );
                log.warn(
                        "event=REALTIME_ANALYSIS_FAILED_RETRYABLE meetingId={} source={} errorCode={} retryAfterSeconds={} retryable={}",
                        meetingId,
                        source,
                        errorCode,
                        retryAfterForFailure,
                        AnalysisFailureMapping.isRetryableErrorCode(errorCode)
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
            int retryAfter = AnalysisFailureMapping.resolveRetryAfterSeconds(errorCode, parseRetryAfter(ex));
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    analysisCacheKey,
                    source,
                    "processing_service_lazy_poll",
                    lockToken,
                    errorCode,
                    safeErrorText(ex.getStatusText()),
                    retryAfter
            );
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED_RETRYABLE meetingId={} source={} errorCode={} httpStatus={} retryAfterSeconds={} retryable={}",
                    meetingId,
                    source,
                    errorCode,
                    ex.getStatusCode().value(),
                    retryAfter,
                    AnalysisFailureMapping.isRetryableErrorCode(errorCode)
            );
        } catch (Exception ex) {
            String errorCode = mapAnalysisFailureCode(ex);
            int retryAfter = AnalysisFailureMapping.resolveRetryAfterSeconds(errorCode, 0);
            jobStateStore.markAnalysisFailed(
                    meetingId,
                    analysisCacheKey,
                    source,
                    "processing_service_lazy_poll",
                    lockToken,
                    errorCode,
                    ex.getClass().getSimpleName(),
                    retryAfter
            );
            log.warn(
                    "event=REALTIME_ANALYSIS_FAILED_RETRYABLE meetingId={} source={} errorCode={} retryAfterSeconds={} retryable={}",
                    meetingId,
                    source,
                    errorCode,
                    retryAfter,
                    AnalysisFailureMapping.isRetryableErrorCode(errorCode)
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
        return fallback.isBlank() ? CANONICAL_ANALYSIS_VERSION : fallback;
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
        return fallback.isBlank() ? CANONICAL_ANALYSIS_VERSION : fallback;
    }

    private String buildAnalysisCacheKey(String transcriptHash, String promptVersion, String schemaVersion) {
        return buildAnalysisCacheKey(transcriptHash, promptVersion, schemaVersion, GROUPED_ACTION_PLAN_FEATURE_SET);
    }

    private String buildAnalysisCacheKey(
            String transcriptHash,
            String promptVersion,
            String schemaVersion,
            String analysisFeatureSet
    ) {
        String normalizedHash = transcriptHash == null ? "" : transcriptHash.trim().toLowerCase(Locale.ROOT);
        String normalizedPromptVersion = promptVersion == null ? "" : promptVersion.trim().toLowerCase(Locale.ROOT);
        String normalizedSchemaVersion = schemaVersion == null ? "" : schemaVersion.trim().toLowerCase(Locale.ROOT);
        String normalizedFeatureSet = analysisFeatureSet == null ? "" : analysisFeatureSet.trim().toLowerCase(Locale.ROOT);
        return normalizedHash + "|" + normalizedPromptVersion + "|" + normalizedSchemaVersion + "|" + normalizedFeatureSet;
    }

    private AnalysisVersionSelection selectAnalysisVersionForWrite(
            Long meetingId,
            String source,
            String requestedPromptVersion,
            String requestedSchemaVersion,
            Map<String, Object> existingAnalysis,
            String traceId
    ) {
        String existingPromptVersion = firstNonBlank(
                existingAnalysis == null ? null : existingAnalysis.get("promptVersion"),
                existingAnalysis == null ? null : existingAnalysis.get("prompt_version")
        );
        String existingSchemaVersion = firstNonBlank(
                existingAnalysis == null ? null : existingAnalysis.get("schemaVersion"),
                existingAnalysis == null ? null : existingAnalysis.get("schema_version")
        );
        String requestedPrompt = firstNonBlank(requestedPromptVersion);
        String requestedSchema = firstNonBlank(requestedSchemaVersion);
        boolean requestedDowngrade = isV1Version(requestedPrompt) || isV1Version(requestedSchema);
        boolean existingV2 = isCanonicalV2(existingPromptVersion) || isCanonicalV2(existingSchemaVersion);
        String reason = "canonical_default";

        if (requestedDowngrade) {
            log.info(
                    "event=ANALYSIS_VERSION_DOWNGRADE_BLOCKED traceId={} requestId={} meetingId={} source={} requestedPromptVersion={} requestedSchemaVersion={} selectedPromptVersion={} selectedSchemaVersion={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    source,
                    requestedPrompt,
                    requestedSchema,
                    CANONICAL_ANALYSIS_VERSION,
                    CANONICAL_ANALYSIS_VERSION
            );
            reason = "downgrade_blocked";
        } else if (existingV2) {
            reason = "existing_v2_preserved";
            log.info(
                    "event=RERUN_ANALYSIS_VERSION_PRESERVED traceId={} requestId={} meetingId={} source={} selectedPromptVersion={} selectedSchemaVersion={}",
                    traceId,
                    currentRequestId(traceId),
                    meetingId,
                    source,
                    CANONICAL_ANALYSIS_VERSION,
                    CANONICAL_ANALYSIS_VERSION
            );
        }

        log.info(
                "event=ANALYSIS_VERSION_SELECTED traceId={} requestId={} meetingId={} source={} requestedPromptVersion={} requestedSchemaVersion={} selectedPromptVersion={} selectedSchemaVersion={} reason={}",
                traceId,
                currentRequestId(traceId),
                meetingId,
                source,
                requestedPrompt,
                requestedSchema,
                CANONICAL_ANALYSIS_VERSION,
                CANONICAL_ANALYSIS_VERSION,
                reason
        );
        return new AnalysisVersionSelection(CANONICAL_ANALYSIS_VERSION, CANONICAL_ANALYSIS_VERSION);
    }

    private boolean isV1Version(String value) {
        return "gemini-business-v1".equalsIgnoreCase(value == null ? "" : value.trim());
    }

    private boolean isCanonicalV2(String value) {
        return CANONICAL_ANALYSIS_VERSION.equalsIgnoreCase(value == null ? "" : value.trim());
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
            return AnalysisFailureMapping.ERROR_CODE_GEMINI_ANALYSIS_FAILED;
        }
        Object explicitErrorCode = response.get("errorCode");
        if (explicitErrorCode != null && !String.valueOf(explicitErrorCode).isBlank()) {
            return String.valueOf(explicitErrorCode).trim().toUpperCase(Locale.ROOT);
        }
        Object reason = response.get("reason");
        String normalized = reason == null ? "" : String.valueOf(reason).trim().toLowerCase(Locale.ROOT);
        if (normalized.contains("empty_transcript")) {
            return AnalysisFailureMapping.ERROR_CODE_EMPTY_TRANSCRIPT;
        }
        if (normalized.contains("circuit_open") || normalized.contains("callnotpermitted")) {
            return AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN;
        }
        if (normalized.contains("unavailable")) {
            return AnalysisFailureMapping.ERROR_CODE_GEMINI_UNAVAILABLE;
        }
        return AnalysisFailureMapping.ERROR_CODE_GEMINI_ANALYSIS_FAILED;
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
        if (summary.isBlank()) {
            summary = safeErrorText(payload.get("meetingSummary"));
        }
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
        int topLevelRetryAfter = parseRetryAfterValue(response.get("retryAfterSeconds"));
        if (topLevelRetryAfter > 0) {
            return topLevelRetryAfter;
        }
        Object details = response.get("details");
        if (details instanceof Map<?, ?> detailMap) {
            return parseRetryAfterValue(detailMap.get("retryAfterSeconds"));
        }
        return 0;
    }

    private int parseRetryAfter(HttpStatusCodeException ex) {
        int bodyRetryAfter = parseRetryAfterFromText(ex.getResponseBodyAsString());
        if (bodyRetryAfter > 0) {
            return bodyRetryAfter;
        }
        String retryAfterHeader = ex.getResponseHeaders() == null
                ? ""
                : ex.getResponseHeaders().getFirst("Retry-After");
        return parseRetryAfterValue(retryAfterHeader);
    }

    private int parseRetryAfterFromText(String text) {
        if (text == null || text.isBlank()) {
            return 0;
        }
        Matcher matcher = RETRY_AFTER_SECONDS_PATTERN.matcher(text);
        if (!matcher.find()) {
            return 0;
        }
        return parseRetryAfterValue(matcher.group(1));
    }

    private int parseRetryAfterValue(Object value) {
        if (value == null) {
            return 0;
        }
        try {
            return Math.max(0, Integer.parseInt(String.valueOf(value).trim()));
        } catch (NumberFormatException ex) {
            return 0;
        }
    }

    private String mapAnalysisFailureCode(Exception ex) {
        return AnalysisFailureMapping.mapFailureCode(ex);
    }

    private ResponseStatusException toAnalysisFailureException(String errorCode, int retryAfterSeconds) {
        String suffix = retryAfterSeconds > 0 ? " retryAfterSeconds=" + retryAfterSeconds : "";
        if (AnalysisFailureMapping.ERROR_CODE_EMPTY_TRANSCRIPT.equals(errorCode)) {
            return new ResponseStatusException(HttpStatus.UNPROCESSABLE_ENTITY, "Empty transcript" + suffix);
        }
        if (AnalysisFailureMapping.ERROR_CODE_GEMINI_UNAVAILABLE.equals(errorCode)
                || AnalysisFailureMapping.ERROR_CODE_CIRCUIT_OPEN.equals(errorCode)) {
            return new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Gemini service unavailable" + suffix);
        }
        if (AnalysisFailureMapping.ERROR_CODE_GEMINI_RATE_LIMITED.equals(errorCode)
                || AnalysisFailureMapping.ERROR_CODE_GEMINI_QUOTA_EXHAUSTED.equals(errorCode)) {
            return new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, "Gemini rate limit reached" + suffix);
        }
        if (AnalysisFailureMapping.ERROR_CODE_AI_SERVICE_UNAVAILABLE.equals(errorCode)) {
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

    private record TranscriptPayload(
            List<Map<String, Object>> readableRows,
            List<Map<String, Object>> rawRows,
            String transcriptMode,
            String canonicalTranscriptVersion,
            String canonicalTranscriptHash,
            String canonicalGeneratedAt
    ) {
        static TranscriptPayload empty() {
            return new TranscriptPayload(
                    List.of(),
                    List.of(),
                    TRANSCRIPT_MODE_RAW,
                    null,
                    null,
                    null
            );
        }

        boolean isCanonicalMode() {
            return TRANSCRIPT_MODE_CANONICAL.equals(transcriptMode);
        }
    }

    private record TranscriptSourceDecision(TranscriptPayload payload, String source) {
    }

    private record AnalysisTriggerResult(String status, String errorCode, int retryAfterSeconds) {
    }

    private record AnalysisVersionSelection(String promptVersion, String schemaVersion) {
    }

    private enum TranscriptExportMode {
        READABLE,
        RAW;

        static TranscriptExportMode from(String value) {
            if (value == null) {
                return READABLE;
            }
            String normalized = value.trim().toLowerCase(Locale.ROOT);
            if (normalized.isBlank() || "readable".equals(normalized)) {
                return READABLE;
            }
            if ("raw".equals(normalized)) {
                return RAW;
            }
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only readable and raw transcript modes are supported");
        }
    }

    private record RawTranscriptPreview(List<MeetingReportData.RawTranscriptRow> rows, boolean previewLimited) {
    }

    private record StabilizedTranscriptResult(
            List<Map<String, Object>> rows,
            Map<String, Object> speakerStats,
            String stabilizationVersion
    ) {
    }

    private record RawTranscriptCandidate(
            double startTimeSeconds,
            double endTimeSeconds,
            String speaker,
            String rawText
    ) {
    }

    private static final class SpeakerStabilizationCounters {
        private int mergedIslandCount;
        private int mergedTinyFragmentCount;
    }

    private static final class SpeakerDisplaySegment {
        private final Map<String, Object> row;
        private final int originalIndex;
        private final boolean hasTiming;
        private final LinkedHashSet<String> providerSpeakers;
        private final LinkedHashSet<String> originalSpeakers;
        private double startTimeSeconds;
        private double endTimeSeconds;
        private String stableSpeaker;
        private String text;
        private boolean mergedIsland;

        private SpeakerDisplaySegment(
                Map<String, Object> row,
                int originalIndex,
                boolean hasTiming,
                LinkedHashSet<String> providerSpeakers,
                LinkedHashSet<String> originalSpeakers,
                double startTimeSeconds,
                double endTimeSeconds,
                String stableSpeaker,
                String text
        ) {
            this.row = row;
            this.originalIndex = originalIndex;
            this.hasTiming = hasTiming;
            this.providerSpeakers = providerSpeakers;
            this.originalSpeakers = originalSpeakers;
            this.startTimeSeconds = startTimeSeconds;
            this.endTimeSeconds = endTimeSeconds;
            this.stableSpeaker = stableSpeaker;
            this.text = text;
        }

        private static SpeakerDisplaySegment fromRow(
                Map<String, Object> row,
                int originalIndex,
                String text,
                String originalSpeaker,
                double startTimeSeconds,
                double endTimeSeconds,
                boolean hasTiming
        ) {
            LinkedHashSet<String> providerSpeakers = new LinkedHashSet<>();
            LinkedHashSet<String> originalSpeakers = new LinkedHashSet<>();
            String speaker = originalSpeaker == null ? "" : originalSpeaker.trim();
            if (!speaker.isBlank()) {
                providerSpeakers.add(speaker);
                originalSpeakers.add(speaker);
            }
            return new SpeakerDisplaySegment(
                    new HashMap<>(row),
                    originalIndex,
                    hasTiming,
                    providerSpeakers,
                    originalSpeakers,
                    startTimeSeconds,
                    endTimeSeconds,
                    "",
                    text
            );
        }

        private String originalSpeaker() {
            if (!originalSpeakers.isEmpty()) {
                return originalSpeakers.iterator().next();
            }
            return "";
        }

        private SpeakerDisplaySegment merge(SpeakerDisplaySegment next) {
            Map<String, Object> mergedRow = new HashMap<>(row);
            LinkedHashSet<String> mergedProviderSpeakers = new LinkedHashSet<>(providerSpeakers);
            mergedProviderSpeakers.addAll(next.providerSpeakers);
            LinkedHashSet<String> mergedOriginalSpeakers = new LinkedHashSet<>(originalSpeakers);
            mergedOriginalSpeakers.addAll(next.originalSpeakers);
            SpeakerDisplaySegment merged = new SpeakerDisplaySegment(
                    mergedRow,
                    originalIndex,
                    hasTiming || next.hasTiming,
                    mergedProviderSpeakers,
                    mergedOriginalSpeakers,
                    Math.min(startTimeSeconds, next.startTimeSeconds),
                    Math.max(endTimeSeconds, next.endTimeSeconds),
                    stableSpeaker,
                    appendText(text, next.text)
            );
            merged.mergedIsland = mergedIsland || next.mergedIsland;
            return merged;
        }

        private static String appendText(String current, String next) {
            String left = current == null ? "" : current.trim();
            String right = next == null ? "" : next.trim();
            if (left.isBlank()) {
                return right;
            }
            if (right.isBlank()) {
                return left;
            }
            return left + " " + right;
        }
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
