package com.example.processingservice.controller;

import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;

import org.slf4j.MDC;
import org.springframework.core.io.ByteArrayResource;
import org.springframework.core.io.Resource;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.controller.dto.AnalysisResponse;
import com.example.processingservice.controller.dto.AnalysisRerunRequest;
import com.example.processingservice.controller.dto.ProcessStartRequest;
import com.example.processingservice.controller.dto.ProcessStartResponse;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import com.example.processingservice.controller.dto.TranscriptSearchResponse;
import com.example.processingservice.controller.dto.TranscriptResponse;
import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.ProcessingService;
import com.example.processingservice.service.report.MeetingActionPlanData;

import lombok.RequiredArgsConstructor;

@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")
@RestController
@RequestMapping("/processing")
@RequiredArgsConstructor
public class ProcessingController {

    private final ProcessingService processingService;

    @PostMapping("/upload")
    public Map<String, Object> upload(
            @RequestPart("file") MultipartFile file,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        return processingService.uploadAudio(file, ensureTraceId(traceId), authorization);
    }

    @PostMapping("/realtime/{meetingId}/final-audio-fallback")
    public Map<String, Object> realtimeFinalAudioFallback(
            @PathVariable Long meetingId,
            @RequestPart("file") MultipartFile file,
            @RequestParam(required = false) String language,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.runRealtimeFinalAudioFallback(
                meetingId,
                file,
                language,
                ensureTraceId(traceId),
                authorization
        );
    }

    @PostMapping("/start")
    public ProcessStartResponse process(
            @RequestBody(required = false) ProcessStartRequest request,
            @RequestParam(required = false) String meetingId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        Long resolvedMeetingId = request != null && request.meeting_id() != null
                ? request.meeting_id()
                : parseMeetingId(meetingId);

        return processingService.startProcessing(
                resolvedMeetingId,
                request == null ? null : request.audio_path(),
            request == null ? null : request.file_id(),
                request == null ? null : request.topic(),
                request == null ? null : request.glossary_terms(),
                request == null ? null : request.language(),
                request == null ? null : request.domain_mode(),
                ensureTraceId(traceId),
                authorization
        );
    }

    @PostMapping("/start/{meetingId}")
    public ProcessStartResponse processByPath(
            @PathVariable Long meetingId,
            @RequestParam(required = false) String fileId,
            @RequestParam(required = false) String topic,
            @RequestParam(name = "glossary_terms", required = false) List<String> glossaryTerms,
            @RequestParam(required = false) String language,
            @RequestParam(name = "domain_mode", required = false) String domainMode,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        return processingService.startProcessing(meetingId, null, fileId, topic, glossaryTerms, language, domainMode, ensureTraceId(traceId), authorization);
    }

    @GetMapping("/me/jobs")
    public Map<String, Object> myJobs(
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization
    ) {
        requirePrincipal();
        return processingService.listMyJobs(ensureTraceId(traceId), authorization);
    }

    @GetMapping("/status/{jobId}")
    public ProcessingStatusResponse statusByJob(
            @PathVariable Long jobId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.getProcessingStatus(jobId, ensureTraceId(traceId), authorization);
    }

    @GetMapping("/{meetingId}/status")
    public ProcessingStatusResponse status(
            @PathVariable Long meetingId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.getProcessingStatus(meetingId, ensureTraceId(traceId), authorization);
    }

    @GetMapping("/{meetingId}/transcript")
    public TranscriptResponse transcript(
            @PathVariable Long meetingId,
            @RequestParam(name = "recording_session_id", required = false) Long recordingSessionId,
            @RequestParam(name = "attempt_id", required = false) Long attemptId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return new TranscriptResponse(
                meetingId,
                processingService.getTranscript(meetingId, ensureTraceId(traceId), authorization, recordingSessionId, attemptId)
        );
    }

    @GetMapping("/{meetingId}/result-scopes")
    public Map<String, Object> listResultScopes(
            @PathVariable Long meetingId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.listMeetingResultScopes(meetingId, ensureTraceId(traceId), authorization);
    }

    @GetMapping("/{meetingId}/result-scope")
    public Map<String, Object> resolveResultScope(
            @PathVariable Long meetingId,
            @RequestParam(name = "recording_session_id", required = false) Long recordingSessionId,
            @RequestParam(name = "attempt_id", required = false) Long attemptId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.resolveMeetingResultScope(
                meetingId,
                ensureTraceId(traceId),
                authorization,
                recordingSessionId,
                attemptId
        );
    }

    @GetMapping("/{meetingId}/transcript/search")
    public TranscriptSearchResponse searchTranscript(
            @PathVariable Long meetingId,
            @RequestParam(name = "q", required = false) String query,
            @RequestParam(name = "limit", required = false) String limit,
            @RequestParam(name = "context", required = false) String context,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.searchTranscriptEvidenceForMeeting(
                meetingId,
                query,
                parseSearchLimit(limit),
                parseSearchContext(context),
                ensureTraceId(traceId),
                authorization
        );
    }

    @GetMapping("/{meetingId}/transcript/export")
    public ResponseEntity<Resource> exportTranscript(
            @PathVariable Long meetingId,
            @RequestParam(defaultValue = "txt") String format,
            @RequestParam(defaultValue = "readable") String mode,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();

        String normalizedFormat = format == null ? "txt" : format.trim().toLowerCase();
        String normalizedMode = mode == null ? "readable" : mode.trim().toLowerCase();
        byte[] exportBytes;
        String filename;
        MediaType mediaType;

        switch (normalizedFormat) {
            case "txt" -> {
                exportBytes = processingService.generateMeetingTranscriptTxt(meetingId, ensureTraceId(traceId), authorization, normalizedMode);
                filename = "meeting-" + meetingId + "-transcript-" + normalizedMode + ".txt";
                mediaType = MediaType.parseMediaType("text/plain; charset=utf-8");
            }
            case "csv" -> {
                exportBytes = processingService.generateMeetingTranscriptCsv(meetingId, ensureTraceId(traceId), authorization, normalizedMode);
                filename = "meeting-" + meetingId + "-transcript-" + normalizedMode + ".csv";
                mediaType = MediaType.parseMediaType("text/csv; charset=utf-8");
            }
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only txt and csv formats are supported");
        }

        return ResponseEntity.ok()
                .contentType(mediaType)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentLength(exportBytes.length)
                .body(new ByteArrayResource(exportBytes));
    }

    @GetMapping("/{meetingId}/analysis")
    public AnalysisResponse analysis(
            @PathVariable Long meetingId,
            @RequestParam(name = "recording_session_id", required = false) Long recordingSessionId,
            @RequestParam(name = "attempt_id", required = false) Long attemptId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return new AnalysisResponse(
                meetingId,
                processingService.getAnalysis(
                        meetingId,
                        ensureTraceId(traceId),
                        authorization,
                        recordingSessionId,
                        attemptId
                )
        );
    }

    @GetMapping("/{meetingId}/analysis/saved")
    public AnalysisResponse savedAnalysis(
            @PathVariable Long meetingId,
            @RequestParam(name = "recording_session_id", required = false) Long recordingSessionId,
            @RequestParam(name = "attempt_id", required = false) Long attemptId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return new AnalysisResponse(
                meetingId,
                processingService.getAnalysisReadOnly(
                        meetingId,
                        ensureTraceId(traceId),
                        authorization,
                        recordingSessionId,
                        attemptId
                )
        );
    }

    @GetMapping("/{meetingId}/action-plan")
    public MeetingActionPlanData actionPlan(
            @PathVariable Long meetingId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.getMeetingActionPlan(meetingId, ensureTraceId(traceId), authorization);
    }

    @PostMapping("/{meetingId}/analysis/rerun")
    public AnalysisResponse rerunAnalysis(
            @PathVariable Long meetingId,
            @RequestBody(required = false) AnalysisRerunRequest request,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String mode = request == null ? null : request.mode();
        String reason = request == null ? null : request.reason();
        String promptVersion = request == null ? null : request.prompt_version();
        String schemaVersion = request == null ? null : request.schema_version();
        String domainMode = request == null ? null : request.domain_mode();
        Long reanalysisGeneration = request == null ? null : request.reanalysis_generation();
        return new AnalysisResponse(
                meetingId,
                processingService.reanalyzeMeetingAnalysis(
                        meetingId,
                        mode,
                        reason,
                        promptVersion,
                        schemaVersion,
                        domainMode,
                        reanalysisGeneration,
                        ensureTraceId(traceId),
                        authorization
                )
        );
    }

    @GetMapping("/{meetingId}/report")
    public ResponseEntity<Resource> exportReport(
            @PathVariable Long meetingId,
            @RequestParam(defaultValue = "docx") String format,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String normalizedFormat = format == null ? "docx" : format.trim().toLowerCase(Locale.ROOT);
        byte[] reportBytes;
        MediaType contentType;
        String filename;
        if ("pdf".equals(normalizedFormat)) {
            reportBytes = processingService.generateMeetingReportPdf(meetingId, ensureTraceId(traceId), authorization);
            contentType = MediaType.APPLICATION_PDF;
            filename = "meeting-" + meetingId + "-report.pdf";
        } else if ("docx".equals(normalizedFormat)) {
            reportBytes = processingService.generateMeetingReportDocx(meetingId, ensureTraceId(traceId), authorization);
            contentType = MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            filename = "meeting-" + meetingId + "-report.docx";
        } else {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only docx and pdf formats are supported");
        }
        return ResponseEntity.ok()
                .contentType(contentType)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentLength(reportBytes.length)
                .body(new ByteArrayResource(reportBytes));
    }

    @GetMapping("/{meetingId}/action-plan/export")
    public ResponseEntity<Resource> exportActionPlan(
            @PathVariable Long meetingId,
            @RequestParam(defaultValue = "docx") String format,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String normalizedFormat = format == null ? "docx" : format.trim().toLowerCase(Locale.ROOT);
        byte[] exportBytes;
        MediaType contentType;
        String filename;
        if ("pdf".equals(normalizedFormat)) {
            exportBytes = processingService.generateMeetingActionPlanPdf(meetingId, ensureTraceId(traceId), authorization);
            contentType = MediaType.APPLICATION_PDF;
            filename = "meeting-" + meetingId + "-action-plan.pdf";
        } else if ("docx".equals(normalizedFormat)) {
            exportBytes = processingService.generateMeetingActionPlanDocx(meetingId, ensureTraceId(traceId), authorization);
            contentType = MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
            filename = "meeting-" + meetingId + "-action-plan.docx";
        } else {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only docx and pdf formats are supported");
        }
        return ResponseEntity.ok()
                .contentType(contentType)
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentLength(exportBytes.length)
                .body(new ByteArrayResource(exportBytes));
    }

    @PostMapping("/{meetingId}/chat")
    public Map<String, Object> meetingChat(
            @PathVariable Long meetingId,
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String question = body == null || body.get("question") == null
                ? ""
                : String.valueOf(body.get("question"));
        return processingService.answerMeetingChat(meetingId, question, ensureTraceId(traceId), authorization);
    }

    @PostMapping("/{meetingId}/terms/explain")
    public Map<String, Object> explainMeetingTerm(
            @PathVariable Long meetingId,
            @RequestBody Map<String, Object> body,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String term = body == null || body.get("term") == null
                ? ""
                : String.valueOf(body.get("term"));
        return processingService.explainMeetingTerm(meetingId, term, ensureTraceId(traceId), authorization);
    }

    @PostMapping("/search/semantic")
    public Map<String, Object> semanticSearch(
            @RequestBody Map<String, Object> body,
            @RequestParam(required = false, defaultValue = "10") String limit,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String query = body == null || body.get("query") == null
                ? ""
                : String.valueOf(body.get("query"));
        return processingService.semanticSearchMeetings(
                query,
                parseSearchLimit(limit),
                ensureTraceId(traceId),
                authorization
        );
    }

    @PostMapping("/cross-meeting/ask")
    public Map<String, Object> askCrossMeeting(
            @RequestBody Map<String, Object> body,
            @RequestParam(required = false, defaultValue = "5") String limit,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        String question = body == null || body.get("question") == null
                ? ""
                : String.valueOf(body.get("question"));
        int parsedLimit = parseSearchLimit(limit);
        return processingService.askCrossMeeting(question, parsedLimit, ensureTraceId(traceId), authorization);
    }

    private UserPrincipal requirePrincipal() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    private Long parseMeetingId(String meetingId) {
        if (meetingId == null || meetingId.isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "meetingId is required and must be a positive integer"
            );
        }

        try {
            Long parsed = Long.parseLong(meetingId);
            if (parsed <= 0) {
                throw new NumberFormatException("meetingId must be greater than 0");
            }
            return parsed;
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "meetingId must be a positive integer"
            );
        }
    }

    private int parseSearchLimit(String limit) {
        if (limit == null || limit.isBlank()) {
            return 20;
        }
        try {
            int parsed = Integer.parseInt(limit.trim());
            if (parsed <= 0) {
                throw new NumberFormatException("limit must be positive");
            }
            return Math.min(parsed, 50);
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_SEARCH_LIMIT");
        }
    }

    private int parseSearchContext(String context) {
        if (context == null || context.isBlank()) {
            return 1;
        }
        try {
            int parsed = Integer.parseInt(context.trim());
            if (parsed < 0) {
                throw new NumberFormatException("context must be non-negative");
            }
            return Math.min(parsed, 3);
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_SEARCH_CONTEXT");
        }
    }

    private String ensureTraceId(String traceId) {
        if (traceId != null && !traceId.isBlank()) {
            return traceId;
        }
        String mdcTraceId = MDC.get("traceId");
        if (mdcTraceId != null && !mdcTraceId.isBlank()) {
            return mdcTraceId;
        }
        return UUID.randomUUID().toString();
    }
}
