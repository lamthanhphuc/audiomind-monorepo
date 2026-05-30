package com.example.processingservice.service.report;

import java.util.List;

public record MeetingReportData(
        MeetingMetadata meetingMetadata,
        String businessSummary,
        List<String> decisions,
        List<ReportActionItem> actionItems,
        List<String> risks,
        List<String> blockers,
        List<String> nextSteps,
        List<String> questions,
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
            String evidence
    ) {
    }

    public record AnalysisMetadata(
            String status,
            String promptVersion,
            String schemaVersion,
            String transcriptHash,
            String confidence,
            String domainMode,
            String source
    ) {
    }
}
