package com.example.processingservice.service.report;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

import org.apache.poi.xwpf.usermodel.ParagraphAlignment;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.springframework.stereotype.Component;

import com.example.processingservice.controller.dto.TranscriptEvidenceContext;
import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;

@Component
public class MeetingActionPlanDocxGenerator {

    public byte[] generate(MeetingActionPlanData actionPlan) {
        try (XWPFDocument doc = new XWPFDocument();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            addTitle(doc, "Meeting Action Plan");
            addHeading(doc, "Meeting Metadata");
            XWPFTable metadataTable = doc.createTable(1, 2);
            setCell(metadataTable.getRow(0), 0, "Field");
            setCell(metadataTable.getRow(0), 1, "Value");
            appendRow(metadataTable, "Meeting ID", safe(actionPlan.meeting().meetingId()));
            appendRow(metadataTable, "Title", actionPlan.meeting().title());
            appendRow(metadataTable, "Created At", actionPlan.meeting().createdAt());
            appendRow(metadataTable, "Language", actionPlan.meeting().language());
            appendRow(metadataTable, "Status", actionPlan.meeting().status());
            appendRow(metadataTable, "Original File", actionPlan.meeting().originalFileName());
            appendRow(metadataTable, "Owner", actionPlan.meeting().ownerUserId());

            addHeading(doc, "Summary");
            addParagraph(doc, defaultText(actionPlan.summary()));

            addHeading(doc, "Action Plan");
            addActionPlanTable(doc, actionPlan);

            addHeading(doc, "CÔNG VIỆC CẦN LÀM THEO NHÓM CHỨC NĂNG");
            addGroupedActionPlan(doc, actionPlan.groupedActionPlan());

            addHeading(doc, "Pain Points");
            addPainPoints(doc, actionPlan.painPoints());

            addHeading(doc, "Risks and Blockers");
            addBulletList(doc, merge(actionPlan.risks(), actionPlan.blockers()));

            addHeading(doc, "Evidence Appendix");
            addEvidenceAppendix(doc, actionPlan.actionItems());

            addHeading(doc, "Analysis Metadata");
            XWPFTable analysisMetadataTable = doc.createTable(1, 2);
            setCell(analysisMetadataTable.getRow(0), 0, "Field");
            setCell(analysisMetadataTable.getRow(0), 1, "Value");
            appendRow(analysisMetadataTable, "Provider", actionPlan.analysisMetadata().provider());
            appendRow(analysisMetadataTable, "Model", actionPlan.analysisMetadata().model());
            appendRow(analysisMetadataTable, "Prompt Version", actionPlan.analysisMetadata().promptVersion());
            appendRow(analysisMetadataTable, "Schema Version", actionPlan.analysisMetadata().schemaVersion());
            appendRow(analysisMetadataTable, "Analysis Source", actionPlan.analysisMetadata().analysisSource());
            appendRow(analysisMetadataTable, "Cache Only", String.valueOf(actionPlan.analysisMetadata().cacheOnly()));
            appendRow(analysisMetadataTable, "Stale", String.valueOf(actionPlan.analysisMetadata().stale()));
            appendRow(analysisMetadataTable, "Canonical Transcript Hash", actionPlan.analysisMetadata().canonicalTranscriptHash());
            appendRow(analysisMetadataTable, "Canonical Transcript Version", actionPlan.analysisMetadata().canonicalTranscriptVersion());

            addHeading(doc, "Generated");
            addParagraph(doc, actionPlan.generatedAt());

            doc.write(out);
            return out.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to generate meeting action plan DOCX", ex);
        }
    }

    private void addActionPlanTable(XWPFDocument doc, MeetingActionPlanData actionPlan) {
        XWPFTable table = doc.createTable(1, 6);
        setCell(table.getRow(0), 0, "Task");
        setCell(table.getRow(0), 1, "Owner");
        setCell(table.getRow(0), 2, "Deadline");
        setCell(table.getRow(0), 3, "Priority");
        setCell(table.getRow(0), 4, "Status");
        setCell(table.getRow(0), 5, "Evidence");

        if (actionPlan.actionItems().isEmpty()) {
            XWPFTableRow row = table.createRow();
            setCell(row, 0, defaultText(actionPlan.note()));
            setCell(row, 1, "");
            setCell(row, 2, "");
            setCell(row, 3, "");
            setCell(row, 4, "");
            setCell(row, 5, "");
            return;
        }

        for (MeetingActionPlanData.ActionItem item : actionPlan.actionItems()) {
            XWPFTableRow row = table.createRow();
            setCell(row, 0, item.task());
            setCell(row, 1, item.owner());
            setCell(row, 2, firstNonBlank(item.deadline(), item.dueDate()));
            setCell(row, 3, item.priority());
            setCell(row, 4, item.status());
            setCell(row, 5, evidenceText(item));
        }
    }

    private void addPainPoints(XWPFDocument doc, List<MeetingActionPlanData.PainPoint> painPoints) {
        if (painPoints == null || painPoints.isEmpty()) {
            addParagraph(doc, "N/A");
            return;
        }
        for (MeetingActionPlanData.PainPoint painPoint : painPoints) {
            addParagraph(doc, "- " + defaultText(painPoint.title())
                    + " (severity: " + defaultText(painPoint.severity()) + ")");
            if (painPoint.evidence() != null && !painPoint.evidence().isBlank()) {
                addParagraph(doc, "  note: " + painPoint.evidence());
            }
        }
    }

    private void addGroupedActionPlan(XWPFDocument doc, MeetingActionPlanData.GroupedActionPlan groupedActionPlan) {
        if (groupedActionPlan == null) {
            addParagraph(doc, "Chưa có công việc đủ rõ để phân nhóm.");
            return;
        }
        addParagraph(doc, defaultText(groupedActionPlan.intro()));
        if (groupedActionPlan.sections() == null || groupedActionPlan.sections().isEmpty()) {
            addParagraph(doc, "Chưa có công việc đủ rõ để phân nhóm.");
        } else {
            for (MeetingActionPlanData.GroupedSection section : groupedActionPlan.sections()) {
                addParagraph(doc, section.order() + ". " + defaultText(section.title()));
                if (section.summary() != null && !section.summary().isBlank()) {
                    addParagraph(doc, "  " + section.summary());
                }
                for (MeetingActionPlanData.GroupedItem item : safeList(section.items())) {
                    addParagraph(doc, "- " + defaultText(item.title()));
                    if (item.description() != null && !item.description().isBlank()) {
                        addParagraph(doc, "  " + item.description());
                    }
                    String metadata = groupedItemMetadata(item);
                    if (!metadata.isBlank()) {
                        addParagraph(doc, "  " + metadata);
                    }
                    for (MeetingActionPlanData.GroupedSubtask subtask : safeList(item.subtasks())) {
                        addParagraph(doc, "  - " + defaultText(subtask.text()));
                        addParagraph(doc, "    " + groupedEvidenceText(subtask.evidence(), subtask.unverifiedEvidenceNote()));
                    }
                    addParagraph(doc, "  " + groupedEvidenceText(item.evidence(), item.unverifiedEvidenceNote()));
                }
            }
        }
        if (groupedActionPlan.notes() != null && !groupedActionPlan.notes().isEmpty()) {
            addParagraph(doc, "Notes");
            for (MeetingActionPlanData.GroupedNote note : groupedActionPlan.notes()) {
                addParagraph(doc, "- " + defaultText(note.text()));
            }
        }
    }

    private void addEvidenceAppendix(XWPFDocument doc, List<MeetingActionPlanData.ActionItem> items) {
        if (items == null || items.isEmpty()) {
            addParagraph(doc, "No transcript evidence available.");
            return;
        }
        boolean hasVerifiedEvidence = false;
        for (MeetingActionPlanData.ActionItem item : items) {
            if (item.evidence() == null) {
                continue;
            }
            hasVerifiedEvidence = true;
            addParagraph(doc, "- " + item.task());
            addParagraph(doc, "  " + evidenceText(item));
            addContextRows(doc, "  before: ", item.evidence().contextBefore());
            addContextRows(doc, "  after: ", item.evidence().contextAfter());
        }
        if (!hasVerifiedEvidence) {
            addParagraph(doc, "No transcript evidence available.");
        }
    }

    private void addContextRows(XWPFDocument doc, String prefix, List<TranscriptEvidenceContext> contexts) {
        if (contexts == null || contexts.isEmpty()) {
            return;
        }
        for (TranscriptEvidenceContext context : contexts) {
            addParagraph(doc, prefix + defaultText(context.speaker()) + " " + timeRange(context.startTime(), context.endTime()));
        }
    }

    private String evidenceText(MeetingActionPlanData.ActionItem item) {
        if (item.evidence() != null) {
            return "Verified transcript evidence: "
                    + defaultText(item.evidence().speaker())
                    + " "
                    + timeRange(item.evidence().startTime(), item.evidence().endTime())
                    + " - "
                    + defaultText(item.evidence().text());
        }
        return defaultText(item.unverifiedEvidenceNote());
    }

    private String groupedEvidenceText(TranscriptEvidenceMatch evidence, String fallback) {
        if (evidence != null) {
            return "Verified transcript evidence: "
                    + defaultText(evidence.speaker())
                    + " "
                    + timeRange(evidence.startTime(), evidence.endTime())
                    + " - "
                    + defaultText(evidence.text());
        }
        return defaultText(fallback == null || fallback.isBlank() ? "No transcript evidence available." : fallback);
    }

    private String groupedItemMetadata(MeetingActionPlanData.GroupedItem item) {
        List<String> parts = new ArrayList<>();
        if (item.owner() != null && !item.owner().isBlank()) {
            parts.add("Owner: " + item.owner());
        }
        if (item.deadline() != null && !item.deadline().isBlank()) {
            parts.add("Deadline: " + item.deadline());
        }
        if (item.priority() != null && !item.priority().isBlank()) {
            parts.add("Priority: " + item.priority());
        }
        if (item.status() != null && !item.status().isBlank()) {
            parts.add("Status: " + item.status());
        }
        return String.join("; ", parts);
    }

    private <T> List<T> safeList(List<T> values) {
        return values == null ? List.of() : values;
    }

    private void addTitle(XWPFDocument doc, String text) {
        XWPFParagraph paragraph = doc.createParagraph();
        paragraph.setAlignment(ParagraphAlignment.CENTER);
        XWPFRun run = paragraph.createRun();
        run.setBold(true);
        run.setFontSize(18);
        run.setText(text);
    }

    private void addHeading(XWPFDocument doc, String text) {
        XWPFParagraph paragraph = doc.createParagraph();
        XWPFRun run = paragraph.createRun();
        run.setBold(true);
        run.setFontSize(14);
        run.setText(text);
    }

    private void addParagraph(XWPFDocument doc, String text) {
        XWPFParagraph paragraph = doc.createParagraph();
        XWPFRun run = paragraph.createRun();
        run.setText(defaultText(text));
    }

    private void addBulletList(XWPFDocument doc, List<String> lines) {
        if (lines == null || lines.isEmpty()) {
            addParagraph(doc, "N/A");
            return;
        }
        for (String line : lines) {
            addParagraph(doc, "- " + defaultText(line));
        }
    }

    private void appendRow(XWPFTable table, String key, String value) {
        XWPFTableRow row = table.createRow();
        setCell(row, 0, key);
        setCell(row, 1, value);
    }

    private void setCell(XWPFTableRow row, int index, String value) {
        row.getCell(index).setText(defaultText(value));
    }

    private List<String> merge(List<String> first, List<String> second) {
        List<String> merged = new ArrayList<>();
        if (first != null) {
            merged.addAll(first);
        }
        if (second != null) {
            merged.addAll(second);
        }
        return merged;
    }

    private String defaultText(String value) {
        return value == null || value.isBlank() ? "N/A" : value;
    }

    private String firstNonBlank(String first, String second) {
        if (first != null && !first.isBlank()) {
            return first;
        }
        return second;
    }

    private String safe(Object value) {
        return value == null ? "N/A" : String.valueOf(value);
    }

    private String timeRange(double startTime, double endTime) {
        return "[" + startTime + "-" + endTime + "]";
    }
}
