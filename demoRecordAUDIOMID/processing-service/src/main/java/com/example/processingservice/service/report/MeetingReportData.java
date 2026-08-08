package com.example.processingservice.service.report;

import java.util.List;

public record MeetingReportData(
        MeetingMetadata meetingMetadata,
        String businessSummary,
        List<String> keywords,
        List<String> technicalTerms,
        List<String> decisions,
        List<String> painPoints,
        List<ReportActionItem> actionItems,
        List<String> risks,
        List<String> blockers,
        List<String> nextSteps,
        List<String> questions,
        List<String> educationStudyHighlights,
        ImpactSummary impactSummary,
        List<RawTranscriptRow> rawTranscriptRows,
        boolean transcriptPreviewLimited,
        List<AnalyzedHighlightRow> analyzedHighlightRows,
        AnalysisMetadata analysisMetadata,
        boolean analysisAvailable
) {
    public record MeetingMetadata(
            Long meetingId,
            String title,
            String createdAt,
            String recognitionMode,
            String detectedTranscriptLanguage,
            String status,
            String originalFileName,
            String ownerUserId,
            String fileSize
    ) {
    }

    public record RawTranscriptRow(
            int index,
            String startTime,
            String endTime,
            String speaker,
            String rawText
    ) {
    }

    public record AnalyzedHighlightRow(
            int index,
            String category,
            String businessMeaning,
            String owner,
            String dueDate,
            String evidenceOrNote
    ) {
    }

    public record ReportActionItem(
            String task,
            String owner,
            String dueDate,
            String priority,
            String status,
            String evidence
    ) {
    }

    public record ImpactSummary(
            String businessImpact,
            String customerImpact,
            String technicalImpact,
            String confidence
    ) {
    }

    public record AnalysisMetadata(
            String status,
            String cacheHit,
            String stale,
            String staleReason,
            String provider,
            String model,
            String promptVersion,
            String schemaVersion,
            String transcriptHash,
            String canonicalTranscriptHash,
            String canonicalTranscriptVersion,
            String analysisInputMode,
            String lastAnalyzedAt,
            String retryAfterSeconds,
            String confidence,
            String domainMode,
            String source
    ) {
    }
}
