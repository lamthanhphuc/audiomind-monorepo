package com.example.processingservice.controller.dto;

public record AnalysisRerunRequest(
        String mode,
        String reason,
        String transcript,
        String transcript_hash,
        String prompt_version,
        String schema_version,
        String canonical_transcript_hash,
        String canonical_transcript_version,
        @com.fasterxml.jackson.annotation.JsonAlias("domainMode") String domain_mode
) {
}
