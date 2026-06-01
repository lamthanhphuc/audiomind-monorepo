package com.example.processingservice.controller;

import java.util.List;
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
import com.example.processingservice.controller.dto.ProcessStartRequest;
import com.example.processingservice.controller.dto.ProcessStartResponse;
import com.example.processingservice.controller.dto.ProcessingStatusResponse;
import com.example.processingservice.controller.dto.TranscriptResponse;
import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.ProcessingService;

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
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        return processingService.startProcessing(meetingId, null, fileId, topic, glossaryTerms, language, ensureTraceId(traceId), authorization);
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

    @GetMapping("/transcript/{jobId}")
    public Map<String, Object> transcriptByJob(
            @PathVariable Long jobId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return processingService.getTranscript(jobId, ensureTraceId(traceId), authorization);
    }

    @GetMapping("/{meetingId}/transcript")
    public TranscriptResponse transcript(
            @PathVariable Long meetingId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return new TranscriptResponse(meetingId, processingService.getTranscript(meetingId, ensureTraceId(traceId), authorization));
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
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return new AnalysisResponse(meetingId, processingService.getAnalysis(meetingId, ensureTraceId(traceId), authorization));
    }

    @GetMapping("/{meetingId}/analysis/saved")
    public AnalysisResponse savedAnalysis(
            @PathVariable Long meetingId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        return new AnalysisResponse(meetingId, processingService.getAnalysisReadOnly(meetingId, ensureTraceId(traceId), authorization));
    }

    @GetMapping("/{meetingId}/report")
    public ResponseEntity<Resource> exportReport(
            @PathVariable Long meetingId,
            @RequestParam(defaultValue = "docx") String format,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        requirePrincipal();
        if (!"docx".equalsIgnoreCase(format)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Only docx format is supported");
        }

        byte[] reportBytes = processingService.generateMeetingReportDocx(meetingId, ensureTraceId(traceId), authorization);
        String filename = "meeting-" + meetingId + "-report.docx";
        return ResponseEntity.ok()
                .contentType(MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=\"" + filename + "\"")
                .contentLength(reportBytes.length)
                .body(new ByteArrayResource(reportBytes));
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
