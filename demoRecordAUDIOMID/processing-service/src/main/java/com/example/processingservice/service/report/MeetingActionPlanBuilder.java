package com.example.processingservice.service.report;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

import org.springframework.stereotype.Component;

import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;

@Component
public class MeetingActionPlanBuilder {
    private static final String GROUPED_ACTION_PLAN_VERSION = "grouped-action-plan-v1";
    private static final String GROUPED_ACTION_PLAN_INTRO =
            "Dựa trên nội dung cuộc thảo luận trong file audio, dưới đây là danh sách các công việc cần thực hiện, được phân chia theo các nhóm chức năng chính:";
    private static final String GROUPED_EMPTY_STATE = "Chưa có công việc đủ rõ để phân nhóm.";
    private static final int MAX_GROUPED_SECTIONS = 8;
    private static final int MAX_GROUPED_ITEMS = 8;
    private static final int MAX_GROUPED_SUBTASKS = 8;
    private static final int MAX_GROUPED_NOTES = 8;
    private static final int MAX_GROUPED_KEYWORDS = 8;
    private static final int MAX_GROUPED_SOURCE_IDS = 8;
    private static final Pattern WHITESPACE_PATTERN = Pattern.compile("\\s+");
    private static final Pattern TASK_QUERY_SEPARATOR_PATTERN = Pattern.compile("[^\\p{IsAlphabetic}\\p{IsDigit}]+");
    private static final Set<String> TASK_QUERY_STOP_WORDS = Set.of(
            "the", "and", "for", "with", "from", "this", "that", "then", "than", "must", "should",
            "will", "are", "was", "were", "been", "to", "of", "in", "on", "at", "by",
            "a", "an", "is", "be", "or", "as", "de", "va", "la", "cho", "voi", "cua", "cac",
            "mot", "nhung", "nay", "do", "se", "can", "phai", "trong", "tren"
    );

    public MeetingActionPlanData build(
            Long meetingId,
            Map<String, Object> meeting,
            Map<String, Object> analysisPayload,
            EvidenceResolver evidenceResolver,
            String canonicalTranscriptHash,
            String canonicalTranscriptVersion,
            Instant generatedAt
    ) {
        MeetingActionPlanData.Meeting meetingData = new MeetingActionPlanData.Meeting(
                meetingId,
                safeText(meeting.get("title")),
                safeText(meeting.get("createdAt")),
                safeText(meeting.get("language")),
                safeText(meeting.get("status")),
                safeText(meeting.get("originalFileName")),
                safeText(meeting.get("ownerUserId"))
        );
        List<ActionItemDraft> drafts = extractActionItemDrafts(analysisPayload);
        List<MeetingActionPlanData.ActionItem> actionItems = new ArrayList<>();
        for (ActionItemDraft draft : drafts) {
            EvidenceChoice evidenceChoice = resolveEvidence(draft, evidenceResolver);
            actionItems.add(new MeetingActionPlanData.ActionItem(
                    draft.task(),
                    blankToNull(draft.owner()),
                    blankToNull(draft.deadline()),
                    blankToNull(draft.dueDate()),
                    blankToNull(normalizePriority(draft.priority())),
                    normalizeStatus(draft.status()),
                    draft.evidenceKeywords(),
                    blankToNull(draft.evidenceQuote()),
                    evidenceChoice.verifiedEvidence(),
                    evidenceChoice.unverifiedEvidenceNote()
            ));
        }
        MeetingActionPlanData.GroupedActionPlan groupedActionPlan = buildGroupedActionPlan(
                analysisPayload,
                drafts,
                evidenceResolver
        );

        String note = actionItems.isEmpty() ? "No action items available in saved analysis" : null;
        return new MeetingActionPlanData(
                meetingData,
                resolveSummary(analysisPayload),
                firstNonBlank(analysisPayload.get("domainMode"), analysisPayload.get("domain_mode")),
                actionItems,
                extractPainPoints(analysisPayload),
                extractStringList(analysisPayload, "risks"),
                extractStringList(analysisPayload, "blockers"),
                generatedAt.toString(),
                note,
                groupedActionPlan,
                buildAnalysisMetadata(analysisPayload, canonicalTranscriptHash, canonicalTranscriptVersion)
        );
    }

    public String deriveTaskQuery(String task) {
        if (task == null || task.isBlank()) {
            return "";
        }
        String normalized = TASK_QUERY_SEPARATOR_PATTERN.matcher(task.toLowerCase(Locale.ROOT)).replaceAll(" ");
        String[] tokens = WHITESPACE_PATTERN.matcher(normalized.trim()).replaceAll(" ").split(" ");
        List<String> selected = new ArrayList<>();
        for (String token : tokens) {
            if (token.length() < 3 || TASK_QUERY_STOP_WORDS.contains(token)) {
                continue;
            }
            selected.add(token);
            if (selected.size() >= 5) {
                break;
            }
        }
        return String.join(" ", selected);
    }

    private List<ActionItemDraft> extractActionItemDrafts(Map<String, Object> analysisPayload) {
        Object raw = analysisPayload.get("action_items");
        if (!(raw instanceof List<?>)) {
            raw = analysisPayload.get("businessActionItems");
        }
        if (!(raw instanceof List<?>)) {
            raw = analysisPayload.get("actionItems");
        }
        if (!(raw instanceof List<?> items) || items.isEmpty()) {
            return List.of();
        }

        List<ActionItemDraft> drafts = new ArrayList<>();
        Set<String> seenTasks = new LinkedHashSet<>();
        for (Object item : items) {
            ActionItemDraft draft = toActionItemDraft(item);
            if (draft.task().isBlank()) {
                continue;
            }
            String key = normalizeTaskKey(draft.task());
            if (!seenTasks.add(key)) {
                continue;
            }
            drafts.add(draft);
        }
        return drafts;
    }

    private ActionItemDraft toActionItemDraft(Object item) {
        if (item instanceof Map<?, ?> map) {
            return new ActionItemDraft(
                    firstNonBlank(map.get("task"), map.get("description"), map.get("text"), map.get("title")),
                    firstNonBlank(map.get("owner")),
                    firstNonBlank(map.get("deadline")),
                    firstNonBlank(map.get("dueDate"), map.get("due_date")),
                    firstNonBlank(map.get("priority")),
                    firstNonBlank(map.get("status")),
                    extractStringList(map, "evidenceKeywords", "evidence_keywords"),
                    firstNonBlank(map.get("evidenceQuote"), map.get("evidence_quote")),
                    firstNonBlank(map.get("evidence"))
            );
        }
        return new ActionItemDraft(
                item == null ? "" : String.valueOf(item).trim(),
                "",
                "",
                "",
                "",
                "",
                List.of(),
                "",
                ""
        );
    }

    private EvidenceChoice resolveEvidence(ActionItemDraft draft, EvidenceResolver evidenceResolver) {
        TranscriptEvidenceMatch verified = null;
        if (evidenceResolver != null) {
            String query = draft.evidenceKeywords().isEmpty()
                    ? deriveTaskQuery(draft.task())
                    : String.join(" ", draft.evidenceKeywords());
            verified = evidenceResolver.resolve(query);
        }
        if (verified != null) {
            return new EvidenceChoice(verified, null);
        }
        return new EvidenceChoice(null, "No transcript evidence available.");
    }

    private MeetingActionPlanData.GroupedActionPlan buildGroupedActionPlan(
            Map<String, Object> analysisPayload,
            List<ActionItemDraft> flatDrafts,
            EvidenceResolver evidenceResolver
    ) {
        Object raw = analysisPayload.get("groupedActionPlan");
        if (!(raw instanceof Map<?, ?>)) {
            raw = analysisPayload.get("grouped_action_plan");
        }
        MeetingActionPlanData.GroupedActionPlan normalized = normalizeGroupedActionPlan(raw, evidenceResolver);
        if (normalized != null) {
            return normalized;
        }
        return fallbackGroupedActionPlan(flatDrafts, evidenceResolver);
    }

    private MeetingActionPlanData.GroupedActionPlan normalizeGroupedActionPlan(
            Object raw,
            EvidenceResolver evidenceResolver
    ) {
        if (!(raw instanceof Map<?, ?> map)) {
            return null;
        }
        List<MeetingActionPlanData.GroupedSection> sections = new ArrayList<>();
        Object rawSections = map.get("sections");
        if (rawSections instanceof List<?> sectionList) {
            int order = 1;
            Set<String> seenItems = new LinkedHashSet<>();
            for (Object rawSection : sectionList) {
                if (!(rawSection instanceof Map<?, ?> sectionMap) || sections.size() >= MAX_GROUPED_SECTIONS) {
                    continue;
                }
                List<MeetingActionPlanData.GroupedItem> items = normalizeGroupedItems(
                        sectionMap.get("items"),
                        evidenceResolver,
                        seenItems
                );
                if (items.isEmpty()) {
                    continue;
                }
                String title = limitText(firstNonBlank(sectionMap.get("title"), "Công việc chung"), 80);
                sections.add(new MeetingActionPlanData.GroupedSection(
                        firstNonBlank(sectionMap.get("id"), "section-" + order),
                        order,
                        title,
                        blankToNull(limitText(firstNonBlank(sectionMap.get("summary")), 240)),
                        items
                ));
                order++;
            }
        }
        List<MeetingActionPlanData.GroupedNote> notes = normalizeGroupedNotes(map.get("notes"));
        if (sections.isEmpty() && notes.isEmpty()) {
            return null;
        }
        return new MeetingActionPlanData.GroupedActionPlan(
                GROUPED_ACTION_PLAN_VERSION,
                normalizeGroupedLanguage(firstNonBlank(map.get("language"))),
                limitText(firstNonBlank(map.get("intro"), GROUPED_ACTION_PLAN_INTRO), 360),
                sections,
                notes
        );
    }

    private List<MeetingActionPlanData.GroupedItem> normalizeGroupedItems(
            Object raw,
            EvidenceResolver evidenceResolver,
            Set<String> seenItems
    ) {
        if (!(raw instanceof List<?> itemList) || itemList.isEmpty()) {
            return List.of();
        }
        List<MeetingActionPlanData.GroupedItem> items = new ArrayList<>();
        int index = 1;
        for (Object rawItem : itemList) {
            if (!(rawItem instanceof Map<?, ?> itemMap) || items.size() >= MAX_GROUPED_ITEMS) {
                continue;
            }
            String title = limitText(firstNonBlank(itemMap.get("title"), itemMap.get("task")), 120);
            if (title.isBlank()) {
                continue;
            }
            String dedupeKey = normalizeTaskKey(title);
            if (!seenItems.add(dedupeKey)) {
                continue;
            }
            List<String> evidenceKeywords = cappedStrings(itemMap.get("evidenceKeywords"), MAX_GROUPED_KEYWORDS);
            List<String> sourceIds = cappedStrings(itemMap.get("sourceActionItemIds"), MAX_GROUPED_SOURCE_IDS);
            EvidenceChoice evidenceChoice = resolveGroupedEvidence(title, evidenceKeywords, evidenceResolver);
            items.add(new MeetingActionPlanData.GroupedItem(
                    firstNonBlank(itemMap.get("id"), "item-" + index),
                    title,
                    blankToNull(limitText(firstNonBlank(itemMap.get("description")), 500)),
                    normalizeGroupedSubtasks(itemMap.get("subtasks"), evidenceResolver),
                    blankToNull(firstNonBlank(itemMap.get("owner"))),
                    blankToNull(firstNonBlank(itemMap.get("deadline"), itemMap.get("dueDate"), itemMap.get("due_date"))),
                    blankToNull(normalizePriority(firstNonBlank(itemMap.get("priority")))),
                    normalizeStatus(firstNonBlank(itemMap.get("status"))),
                    normalizeGroupedConfidence(firstNonBlank(itemMap.get("confidence")), sourceIds, evidenceChoice.verifiedEvidence()),
                    evidenceKeywords,
                    sourceIds,
                    evidenceChoice.verifiedEvidence(),
                    evidenceChoice.unverifiedEvidenceNote()
            ));
            index++;
        }
        return items;
    }

    private List<MeetingActionPlanData.GroupedSubtask> normalizeGroupedSubtasks(
            Object raw,
            EvidenceResolver evidenceResolver
    ) {
        if (!(raw instanceof List<?> subtaskList) || subtaskList.isEmpty()) {
            return List.of();
        }
        List<MeetingActionPlanData.GroupedSubtask> subtasks = new ArrayList<>();
        int index = 1;
        for (Object rawSubtask : subtaskList) {
            if (subtasks.size() >= MAX_GROUPED_SUBTASKS) {
                break;
            }
            String text;
            List<String> evidenceKeywords;
            String confidence;
            String id;
            if (rawSubtask instanceof Map<?, ?> subtaskMap) {
                text = limitText(firstNonBlank(subtaskMap.get("text"), subtaskMap.get("title"), subtaskMap.get("task")), 180);
                evidenceKeywords = cappedStrings(subtaskMap.get("evidenceKeywords"), MAX_GROUPED_KEYWORDS);
                confidence = firstNonBlank(subtaskMap.get("confidence"));
                id = firstNonBlank(subtaskMap.get("id"), "subtask-" + index);
            } else {
                text = limitText(firstNonBlank(rawSubtask), 180);
                evidenceKeywords = List.of();
                confidence = "";
                id = "subtask-" + index;
            }
            if (text.isBlank()) {
                continue;
            }
            EvidenceChoice evidenceChoice = resolveGroupedEvidence(text, evidenceKeywords, evidenceResolver);
            subtasks.add(new MeetingActionPlanData.GroupedSubtask(
                    id,
                    text,
                    normalizeGroupedConfidence(confidence, List.of(), evidenceChoice.verifiedEvidence()),
                    evidenceKeywords,
                    evidenceChoice.verifiedEvidence(),
                    evidenceChoice.unverifiedEvidenceNote()
            ));
            index++;
        }
        return subtasks;
    }

    private List<MeetingActionPlanData.GroupedNote> normalizeGroupedNotes(Object raw) {
        if (!(raw instanceof List<?> noteList) || noteList.isEmpty()) {
            return List.of();
        }
        List<MeetingActionPlanData.GroupedNote> notes = new ArrayList<>();
        for (Object rawNote : noteList) {
            if (notes.size() >= MAX_GROUPED_NOTES) {
                break;
            }
            String text;
            String confidence;
            List<String> evidenceKeywords;
            if (rawNote instanceof Map<?, ?> noteMap) {
                text = limitText(firstNonBlank(noteMap.get("text"), noteMap.get("note")), 240);
                confidence = firstNonBlank(noteMap.get("confidence"));
                evidenceKeywords = cappedStrings(noteMap.get("evidenceKeywords"), MAX_GROUPED_KEYWORDS);
            } else {
                text = limitText(firstNonBlank(rawNote), 240);
                confidence = "";
                evidenceKeywords = List.of();
            }
            if (text.isBlank()) {
                continue;
            }
            notes.add(new MeetingActionPlanData.GroupedNote(
                    text,
                    normalizeGroupedConfidence(confidence, List.of(), null),
                    evidenceKeywords
            ));
        }
        return notes;
    }

    private MeetingActionPlanData.GroupedActionPlan fallbackGroupedActionPlan(
            List<ActionItemDraft> flatDrafts,
            EvidenceResolver evidenceResolver
    ) {
        if (flatDrafts == null || flatDrafts.isEmpty()) {
            return new MeetingActionPlanData.GroupedActionPlan(
                    GROUPED_ACTION_PLAN_VERSION,
                    "vi",
                    GROUPED_EMPTY_STATE,
                    List.of(),
                    List.of()
            );
        }
        List<MeetingActionPlanData.GroupedItem> items = new ArrayList<>();
        int index = 1;
        for (ActionItemDraft draft : flatDrafts) {
            if (items.size() >= MAX_GROUPED_ITEMS) {
                break;
            }
            EvidenceChoice evidenceChoice = resolveEvidence(draft, evidenceResolver);
            items.add(new MeetingActionPlanData.GroupedItem(
                    "fallback-item-" + index,
                    limitText(draft.task(), 120),
                    null,
                    List.of(),
                    blankToNull(draft.owner()),
                    blankToNull(firstNonBlank(draft.deadline(), draft.dueDate())),
                    blankToNull(normalizePriority(draft.priority())),
                    normalizeStatus(draft.status()),
                    evidenceChoice.verifiedEvidence() == null ? "NEEDS_REVIEW" : "SUPPORTED",
                    cappedStrings(draft.evidenceKeywords(), MAX_GROUPED_KEYWORDS),
                    List.of(),
                    evidenceChoice.verifiedEvidence(),
                    evidenceChoice.unverifiedEvidenceNote()
            ));
            index++;
        }
        return new MeetingActionPlanData.GroupedActionPlan(
                GROUPED_ACTION_PLAN_VERSION,
                "vi",
                GROUPED_ACTION_PLAN_INTRO,
                List.of(new MeetingActionPlanData.GroupedSection(
                        "fallback-section-1",
                        1,
                        "Công việc chung",
                        null,
                        items
                )),
                List.of()
        );
    }

    private EvidenceChoice resolveGroupedEvidence(
            String title,
            List<String> evidenceKeywords,
            EvidenceResolver evidenceResolver
    ) {
        if (evidenceResolver == null) {
            return new EvidenceChoice(null, "No transcript evidence available.");
        }
        String query = evidenceKeywords == null || evidenceKeywords.isEmpty()
                ? deriveTaskQuery(title)
                : String.join(" ", evidenceKeywords);
        if (query == null || query.isBlank()) {
            return new EvidenceChoice(null, "No transcript evidence available.");
        }
        TranscriptEvidenceMatch verified = evidenceResolver.resolve(query);
        if (verified != null) {
            return new EvidenceChoice(verified, null);
        }
        return new EvidenceChoice(null, "No transcript evidence available.");
    }

    private List<String> cappedStrings(Object raw, int maxItems) {
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            return List.of();
        }
        List<String> values = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        for (Object item : list) {
            if (values.size() >= maxItems) {
                break;
            }
            String text = limitText(firstNonBlank(item), 80);
            if (text.isBlank()) {
                continue;
            }
            String key = text.toLowerCase(Locale.ROOT);
            if (seen.add(key)) {
                values.add(text);
            }
        }
        return values;
    }

    private String normalizeGroupedLanguage(String value) {
        String normalized = value == null ? "" : value.trim().toLowerCase(Locale.ROOT);
        if (normalized.equals("vi") || normalized.equals("en") || normalized.equals("mixed")) {
            return normalized;
        }
        return "mixed";
    }

    private String normalizeGroupedConfidence(
            String value,
            List<String> sourceActionItemIds,
            TranscriptEvidenceMatch verifiedEvidence
    ) {
        String normalized = value == null ? "" : value.trim().toUpperCase(Locale.ROOT);
        if (!normalized.equals("SUPPORTED") && !normalized.equals("INFERRED") && !normalized.equals("NEEDS_REVIEW")) {
            return "NEEDS_REVIEW";
        }
        if (normalized.equals("SUPPORTED")
                && (sourceActionItemIds == null || sourceActionItemIds.isEmpty())
                && verifiedEvidence == null) {
            return "NEEDS_REVIEW";
        }
        return normalized;
    }

    private String limitText(String value, int maxChars) {
        String text = value == null ? "" : WHITESPACE_PATTERN.matcher(value.trim()).replaceAll(" ");
        if (text.length() <= maxChars) {
            return text;
        }
        return text.substring(0, Math.max(0, maxChars - 3)).trim() + "...";
    }

    private List<MeetingActionPlanData.PainPoint> extractPainPoints(Map<String, Object> analysisPayload) {
        Object raw = analysisPayload.get("painPoints");
        if (!(raw instanceof List<?>)) {
            raw = analysisPayload.get("pain_points");
        }
        if (!(raw instanceof List<?> list) || list.isEmpty()) {
            return List.of();
        }
        List<MeetingActionPlanData.PainPoint> results = new ArrayList<>();
        for (Object item : list) {
            if (item instanceof Map<?, ?> map) {
                String title = firstNonBlank(map.get("title"), map.get("name"), map.get("text"), map.get("evidence"));
                if (title.isBlank()) {
                    continue;
                }
                results.add(new MeetingActionPlanData.PainPoint(
                        title,
                        firstNonBlank(map.get("severity")),
                        firstNonBlank(map.get("evidence"))
                ));
            } else if (item != null && !String.valueOf(item).trim().isBlank()) {
                results.add(new MeetingActionPlanData.PainPoint(String.valueOf(item).trim(), "", ""));
            }
        }
        return results;
    }

    private List<String> extractStringList(Map<?, ?> payload, String... keys) {
        for (String key : keys) {
            Object raw = payload.get(key);
            if (raw instanceof List<?> list) {
                List<String> values = new ArrayList<>();
                for (Object item : list) {
                    if (item == null) {
                        continue;
                    }
                    String text = String.valueOf(item).trim();
                    if (!text.isBlank()) {
                        values.add(text);
                    }
                }
                return values;
            }
        }
        return List.of();
    }

    private MeetingActionPlanData.AnalysisMetadata buildAnalysisMetadata(
            Map<String, Object> analysisPayload,
            String fallbackCanonicalTranscriptHash,
            String fallbackCanonicalTranscriptVersion
    ) {
        String source = firstNonBlank(
                analysisPayload.get("analysisSource"),
                analysisPayload.get("analysis_source"),
                analysisPayload.get("source")
        );
        boolean cacheOnly = parseBoolean(analysisPayload.get("cacheOnly"))
                || parseBoolean(analysisPayload.get("cacheHit"))
                || "cache_only".equalsIgnoreCase(source);
        if (source.isBlank()) {
            source = cacheOnly ? "cache_only" : "saved";
        }
        return new MeetingActionPlanData.AnalysisMetadata(
                firstNonBlank(analysisPayload.get("provider")),
                firstNonBlank(analysisPayload.get("model")),
                firstNonBlank(analysisPayload.get("promptVersion"), analysisPayload.get("prompt_version")),
                firstNonBlank(analysisPayload.get("schemaVersion"), analysisPayload.get("schema_version")),
                source,
                cacheOnly,
                parseBoolean(analysisPayload.get("stale")),
                firstNonBlank(
                        analysisPayload.get("canonicalTranscriptHash"),
                        analysisPayload.get("canonical_transcript_hash"),
                        fallbackCanonicalTranscriptHash
                ),
                firstNonBlank(
                        analysisPayload.get("canonicalTranscriptVersion"),
                        analysisPayload.get("canonical_transcript_version"),
                        fallbackCanonicalTranscriptVersion
                )
        );
    }

    private String resolveSummary(Map<String, Object> analysisPayload) {
        return firstNonBlank(analysisPayload.get("summary"), analysisPayload.get("meetingSummary"));
    }

    private String normalizePriority(String priority) {
        String normalized = priority == null ? "" : priority.trim().toLowerCase(Locale.ROOT);
        if (normalized.equals("low") || normalized.equals("medium") || normalized.equals("high")) {
            return normalized;
        }
        return "";
    }

    private String normalizeStatus(String status) {
        String normalized = status == null ? "" : status.trim().toLowerCase(Locale.ROOT);
        return switch (normalized) {
            case "in_progress", "blocked", "done", "open" -> normalized;
            case "completed" -> "done";
            case "pending", "" -> "open";
            case "cancelled" -> "blocked";
            default -> "open";
        };
    }

    private boolean parseBoolean(Object value) {
        return value != null && Boolean.parseBoolean(String.valueOf(value));
    }

    private String normalizeTaskKey(String task) {
        return WHITESPACE_PATTERN.matcher(task.trim().toLowerCase(Locale.ROOT)).replaceAll(" ");
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

    private String safeText(Object value) {
        return value == null ? "" : String.valueOf(value).trim();
    }

    private String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value;
    }

    public interface EvidenceResolver {
        TranscriptEvidenceMatch resolve(String query);
    }

    private record ActionItemDraft(
            String task,
            String owner,
            String deadline,
            String dueDate,
            String priority,
            String status,
            List<String> evidenceKeywords,
            String evidenceQuote,
            String legacyEvidence
    ) {
    }

    private record EvidenceChoice(
            TranscriptEvidenceMatch verifiedEvidence,
            String unverifiedEvidenceNote
    ) {
    }
}
