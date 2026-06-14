package com.example.processingservice.service.report;

import java.util.List;

import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;

public record MeetingActionPlanData(
        Meeting meeting,
        String summary,
        String domainMode,
        List<ActionItem> actionItems,
        List<PainPoint> painPoints,
        List<String> risks,
        List<String> blockers,
        String generatedAt,
        String note,
        GroupedActionPlan groupedActionPlan,
        AnalysisMetadata analysisMetadata
) {
    public record Meeting(
            Long meetingId,
            String title,
            String createdAt,
            String language,
            String status,
            String originalFileName,
            String ownerUserId
    ) {
    }

    public record ActionItem(
            String task,
            String owner,
            String deadline,
            String dueDate,
            String priority,
            String status,
            List<String> evidenceKeywords,
            String evidenceQuote,
            TranscriptEvidenceMatch evidence,
            String unverifiedEvidenceNote
    ) {
    }

    public record PainPoint(
            String title,
            String severity,
            String evidence
    ) {
    }

    public record AnalysisMetadata(
            String provider,
            String model,
            String promptVersion,
            String schemaVersion,
            String analysisSource,
            boolean cacheOnly,
            boolean stale,
            String canonicalTranscriptHash,
            String canonicalTranscriptVersion
    ) {
    }

    public record GroupedActionPlan(
            String version,
            String language,
            String intro,
            List<GroupedSection> sections,
            List<GroupedNote> notes
    ) {
    }

    public record GroupedSection(
            String id,
            int order,
            String title,
            String summary,
            List<GroupedItem> items
    ) {
    }

    public record GroupedItem(
            String id,
            String title,
            String description,
            List<GroupedSubtask> subtasks,
            String owner,
            String deadline,
            String priority,
            String status,
            String confidence,
            List<String> evidenceKeywords,
            List<String> sourceActionItemIds,
            TranscriptEvidenceMatch evidence,
            String unverifiedEvidenceNote
    ) {
    }

    public record GroupedSubtask(
            String id,
            String text,
            String confidence,
            List<String> evidenceKeywords,
            TranscriptEvidenceMatch evidence,
            String unverifiedEvidenceNote
    ) {
    }

    public record GroupedNote(
            String text,
            String confidence,
            List<String> evidenceKeywords
    ) {
    }
}
