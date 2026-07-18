package com.example.processingservice.controller;

import java.util.List;
import java.util.Map;
import java.util.UUID;

import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.security.UserPrincipal;
import com.example.processingservice.service.StudyGenerationService;

import lombok.RequiredArgsConstructor;

@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")
@RestController
@RequestMapping("/processing")
@RequiredArgsConstructor
public class StudyGenerationController {

    private final StudyGenerationService studyGenerationService;

    public record SynthesisRequest(
            List<Long> meetingIds,
            String language,
            String sourceSelectionMode) {
    }

    public record StudyArtifactsRequest(
            Long subjectId,
            List<Long> meetingIds,
            List<String> artifactTypes,
            String sourceSelectionMode,
            Map<String, Object> options,
            Long synthesisId) {
    }

    @PostMapping("/subjects/{subjectId}/synthesis")
    public Map<String, Object> createSynthesis(
            @PathVariable Long subjectId,
            @RequestBody(required = false) SynthesisRequest request,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        SynthesisRequest body = request == null ? new SynthesisRequest(null, "vi", "ALL_READY") : request;
        return studyGenerationService.createOrGetSynthesis(
                subjectId,
                principal.userId(),
                body.meetingIds(),
                body.sourceSelectionMode(),
                body.language(),
                false,
                ensureTraceId(traceId),
                authorization);
    }

    @GetMapping("/subjects/{subjectId}/synthesis")
    public Map<String, Object> getSynthesis(
            @PathVariable Long subjectId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        return studyGenerationService.getSynthesis(
                subjectId, principal.userId(), ensureTraceId(traceId), authorization);
    }

    @GetMapping("/subjects/{subjectId}/synthesis/status")
    public Map<String, Object> getSynthesisStatus(
            @PathVariable Long subjectId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        return getSynthesis(subjectId, traceId, authorization);
    }

    @PostMapping("/subjects/{subjectId}/synthesis/regenerate")
    public Map<String, Object> regenerateSynthesis(
            @PathVariable Long subjectId,
            @RequestBody(required = false) SynthesisRequest request,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        SynthesisRequest body = request == null ? new SynthesisRequest(null, "vi", "ALL_READY") : request;
        return studyGenerationService.createOrGetSynthesis(
                subjectId,
                principal.userId(),
                body.meetingIds(),
                body.sourceSelectionMode(),
                body.language(),
                true,
                ensureTraceId(traceId),
                authorization);
    }

    @PostMapping("/study-artifacts")
    public Map<String, Object> createArtifacts(
            @RequestBody StudyArtifactsRequest request,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        if (request == null || request.subjectId() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR.name());
        }
        return studyGenerationService.createStudyArtifacts(
                principal.userId(),
                request.subjectId(),
                request.meetingIds(),
                request.artifactTypes(),
                request.sourceSelectionMode(),
                request.options(),
                request.synthesisId(),
                false,
                ensureTraceId(traceId),
                authorization);
    }

    @GetMapping("/study-artifacts/{artifactId}")
    public Map<String, Object> getArtifact(
            @PathVariable Long artifactId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        return studyGenerationService.getArtifact(
                artifactId, principal.userId(), ensureTraceId(traceId), authorization);
    }

    @GetMapping("/subjects/{subjectId}/study-artifacts")
    public Map<String, Object> listArtifacts(
            @PathVariable Long subjectId,
            @RequestParam(required = false) String artifactType,
            @RequestParam(required = false) String status,
            @RequestParam(required = false) Integer page,
            @RequestParam(required = false) Integer size,
            @RequestParam(required = false) String sort,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        return studyGenerationService.listArtifacts(
                subjectId,
                principal.userId(),
                artifactType,
                status,
                page,
                size,
                sort,
                ensureTraceId(traceId),
                authorization);
    }

    @PostMapping("/study-artifacts/{artifactId}/regenerate")
    public Map<String, Object> regenerateArtifact(
            @PathVariable Long artifactId,
            @RequestBody(required = false) StudyArtifactsRequest request,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        Map<String, Object> existing = studyGenerationService.getArtifact(
                artifactId, principal.userId(), ensureTraceId(traceId), authorization);
        Long subjectId = existing.get("subjectId") instanceof Number n ? n.longValue() : null;
        String artifactType = existing.get("artifactType") instanceof String s ? s : null;
        if (subjectId == null || artifactType == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, ErrorCode.VALIDATION_ERROR.name());
        }
        @SuppressWarnings("unchecked")
        List<Long> sourceMeetingIds = existing.get("sourceMeetingIds") instanceof List<?> list
                ? list.stream()
                        .filter(Number.class::isInstance)
                        .map(Number.class::cast)
                        .map(Number::longValue)
                        .toList()
                : List.of();
        String mode = existing.get("sourceSelectionMode") instanceof String m ? m : "EXPLICIT";
        @SuppressWarnings("unchecked")
        Map<String, Object> options = existing.get("options") instanceof Map<?, ?> map
                ? (Map<String, Object>) map
                : Map.of();
        // Pass null synthesisId so AI regenerates from educationStudy sources
        // instead of reusing a potentially stale subject synthesis.
        return studyGenerationService.createStudyArtifacts(
                principal.userId(),
                subjectId,
                sourceMeetingIds,
                List.of(artifactType),
                mode,
                options,
                null,
                true,
                ensureTraceId(traceId),
                authorization);
    }

    @DeleteMapping("/study-artifacts/{artifactId}")
    public Map<String, Object> deleteArtifact(
            @PathVariable Long artifactId,
            @RequestHeader(value = "x-trace-id", required = false) String traceId,
            @RequestHeader(HttpHeaders.AUTHORIZATION) String authorization) {
        UserPrincipal principal = requirePrincipal();
        return studyGenerationService.deleteArtifact(artifactId, principal.userId(), ensureTraceId(traceId));
    }

    private UserPrincipal requirePrincipal() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, ErrorCode.UNAUTHORIZED.name());
        }
        return principal;
    }

    private String ensureTraceId(String traceId) {
        if (traceId != null && !traceId.isBlank()) {
            return traceId;
        }
        return UUID.randomUUID().toString();
    }
}
