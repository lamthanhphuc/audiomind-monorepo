package com.example.processingservice.service.report;

import com.example.processingservice.controller.dto.TranscriptEvidenceContext;
import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;
import com.lowagie.text.Document;
import com.lowagie.text.Font;
import com.lowagie.text.PageSize;
import com.lowagie.text.Paragraph;
import com.lowagie.text.Phrase;
import com.lowagie.text.pdf.BaseFont;
import com.lowagie.text.pdf.PdfPCell;
import com.lowagie.text.pdf.PdfPTable;
import com.lowagie.text.pdf.PdfWriter;
import java.awt.Color;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class MeetingActionPlanPdfGenerator {

    private static final BaseFont UNICODE_BASE_FONT = resolveUnicodeBaseFont();
    private static final Font TITLE_FONT = new Font(UNICODE_BASE_FONT, 18, Font.BOLD);
    private static final Font HEADING_FONT = new Font(UNICODE_BASE_FONT, 12, Font.BOLD);
    private static final Font BODY_FONT = new Font(UNICODE_BASE_FONT, 10, Font.NORMAL);

    public byte[] generate(MeetingActionPlanData actionPlan) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Document document = new Document(PageSize.A4, 42, 42, 48, 48);
            PdfWriter.getInstance(document, out);
            document.open();

            document.add(new Paragraph("Kế hoạch hành động", TITLE_FONT));
            document.add(spacedParagraph("Meeting #" + safe(actionPlan.meeting().meetingId()), BODY_FONT));
            document.add(blank());

            addHeading(document, "Meeting Metadata");
            PdfPTable metadata = new PdfPTable(2);
            metadata.setWidthPercentage(100);
            addRow(metadata, "Meeting ID", safe(actionPlan.meeting().meetingId()));
            addRow(metadata, "Title", actionPlan.meeting().title());
            addRow(metadata, "Created At", actionPlan.meeting().createdAt());
            addRow(metadata, "Language", actionPlan.meeting().language());
            addRow(metadata, "Status", actionPlan.meeting().status());
            addRow(metadata, "Original File", actionPlan.meeting().originalFileName());
            addRow(metadata, "Owner", actionPlan.meeting().ownerUserId());
            document.add(metadata);
            document.add(blank());

            addHeading(document, "Summary");
            document.add(spacedParagraph(defaultText(actionPlan.summary()), BODY_FONT));
            document.add(blank());

            addHeading(document, "Action Plan");
            addActionPlanTable(document, actionPlan);

            addHeading(document, "Công việc cần làm theo nhóm chức năng");
            addGroupedActionPlan(document, actionPlan.groupedActionPlan());

            addHeading(document, "Pain Points");
            addPainPoints(document, actionPlan.painPoints());

            addHeading(document, "Risks and Blockers");
            addBulletList(document, merge(actionPlan.risks(), actionPlan.blockers()));

            addHeading(document, "Evidence Appendix");
            addEvidenceAppendix(document, actionPlan.actionItems());

            addHeading(document, "Analysis Metadata");
            PdfPTable analysisMetadata = new PdfPTable(2);
            analysisMetadata.setWidthPercentage(100);
            addRow(analysisMetadata, "Provider", actionPlan.analysisMetadata().provider());
            addRow(analysisMetadata, "Model", actionPlan.analysisMetadata().model());
            addRow(analysisMetadata, "Prompt Version", actionPlan.analysisMetadata().promptVersion());
            addRow(analysisMetadata, "Schema Version", actionPlan.analysisMetadata().schemaVersion());
            addRow(analysisMetadata, "Analysis Source", actionPlan.analysisMetadata().analysisSource());
            addRow(analysisMetadata, "Cache Only", String.valueOf(actionPlan.analysisMetadata().cacheOnly()));
            addRow(analysisMetadata, "Stale", String.valueOf(actionPlan.analysisMetadata().stale()));
            addRow(analysisMetadata, "Canonical Transcript Hash", actionPlan.analysisMetadata().canonicalTranscriptHash());
            addRow(analysisMetadata, "Canonical Transcript Version", actionPlan.analysisMetadata().canonicalTranscriptVersion());
            document.add(analysisMetadata);
            document.add(blank());

            addHeading(document, "Generated");
            document.add(spacedParagraph(defaultText(actionPlan.generatedAt()), BODY_FONT));

            document.close();
            return out.toByteArray();
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to generate action plan PDF", ex);
        }
    }

    private void addActionPlanTable(Document document, MeetingActionPlanData actionPlan) throws Exception {
        PdfPTable table = new PdfPTable(6);
        table.setWidthPercentage(100);
        addHeader(table, "Task", "Owner", "Deadline", "Priority", "Status", "Evidence");

        if (actionPlan.actionItems() == null || actionPlan.actionItems().isEmpty()) {
            table.addCell(cell(defaultText(actionPlan.note())));
            for (int i = 0; i < 5; i++) {
                table.addCell(cell(""));
            }
            document.add(table);
            document.add(blank());
            return;
        }

        for (MeetingActionPlanData.ActionItem item : actionPlan.actionItems()) {
            table.addCell(cell(defaultText(item.task())));
            table.addCell(cell(defaultText(item.owner())));
            table.addCell(cell(defaultText(firstNonBlank(item.deadline(), item.dueDate()))));
            table.addCell(cell(defaultText(item.priority())));
            table.addCell(cell(defaultText(item.status())));
            table.addCell(cell(evidenceText(item)));
        }
        document.add(table);
        document.add(blank());
    }

    private void addGroupedActionPlan(Document document, MeetingActionPlanData.GroupedActionPlan groupedActionPlan) throws Exception {
        if (groupedActionPlan == null) {
            document.add(spacedParagraph("Chưa có công việc đủ rõ để phân nhóm.", BODY_FONT));
            document.add(blank());
            return;
        }
        document.add(spacedParagraph(defaultText(groupedActionPlan.intro()), BODY_FONT));
        if (groupedActionPlan.sections() == null || groupedActionPlan.sections().isEmpty()) {
            document.add(spacedParagraph("Chưa có công việc đủ rõ để phân nhóm.", BODY_FONT));
        } else {
            for (MeetingActionPlanData.GroupedSection section : groupedActionPlan.sections()) {
                document.add(spacedParagraph(section.order() + ". " + defaultText(section.title()), HEADING_FONT));
                if (section.summary() != null && !section.summary().isBlank()) {
                    document.add(spacedParagraph(section.summary(), BODY_FONT));
                }
                for (MeetingActionPlanData.GroupedItem item : safeList(section.items())) {
                    document.add(spacedParagraph("- " + defaultText(item.title()), BODY_FONT));
                    if (item.description() != null && !item.description().isBlank()) {
                        document.add(spacedParagraph("  " + item.description(), BODY_FONT));
                    }
                    String metadata = groupedItemMetadata(item);
                    if (!metadata.isBlank()) {
                        document.add(spacedParagraph("  " + metadata, BODY_FONT));
                    }
                    for (MeetingActionPlanData.GroupedSubtask subtask : safeList(item.subtasks())) {
                        document.add(spacedParagraph("  - " + defaultText(subtask.text()), BODY_FONT));
                        document.add(spacedParagraph("    " + groupedEvidenceText(subtask.evidence(), subtask.unverifiedEvidenceNote()), BODY_FONT));
                    }
                    document.add(spacedParagraph("  " + groupedEvidenceText(item.evidence(), item.unverifiedEvidenceNote()), BODY_FONT));
                }
            }
        }
        if (groupedActionPlan.notes() != null && !groupedActionPlan.notes().isEmpty()) {
            document.add(spacedParagraph("Notes", HEADING_FONT));
            for (MeetingActionPlanData.GroupedNote note : groupedActionPlan.notes()) {
                document.add(spacedParagraph("- " + defaultText(note.text()), BODY_FONT));
            }
        }
        document.add(blank());
    }

    private void addPainPoints(Document document, List<MeetingActionPlanData.PainPoint> painPoints) throws Exception {
        if (painPoints == null || painPoints.isEmpty()) {
            document.add(spacedParagraph("N/A", BODY_FONT));
            document.add(blank());
            return;
        }
        for (MeetingActionPlanData.PainPoint painPoint : painPoints) {
            document.add(spacedParagraph(
                    "- " + defaultText(painPoint.title()) + " (severity: " + defaultText(painPoint.severity()) + ")",
                    BODY_FONT
            ));
            if (painPoint.evidence() != null && !painPoint.evidence().isBlank()) {
                document.add(spacedParagraph("  note: " + painPoint.evidence(), BODY_FONT));
            }
        }
        document.add(blank());
    }

    private void addEvidenceAppendix(Document document, List<MeetingActionPlanData.ActionItem> items) throws Exception {
        if (items == null || items.isEmpty()) {
            document.add(spacedParagraph("No transcript evidence available.", BODY_FONT));
            document.add(blank());
            return;
        }
        boolean hasVerifiedEvidence = false;
        for (MeetingActionPlanData.ActionItem item : items) {
            if (item.evidence() == null) {
                continue;
            }
            hasVerifiedEvidence = true;
            document.add(spacedParagraph("- " + defaultText(item.task()), BODY_FONT));
            document.add(spacedParagraph("  " + evidenceText(item), BODY_FONT));
            addContextRows(document, "  before: ", item.evidence().contextBefore());
            addContextRows(document, "  after: ", item.evidence().contextAfter());
        }
        if (!hasVerifiedEvidence) {
            document.add(spacedParagraph("No transcript evidence available.", BODY_FONT));
        }
        document.add(blank());
    }

    private void addContextRows(Document document, String prefix, List<TranscriptEvidenceContext> contexts) throws Exception {
        if (contexts == null || contexts.isEmpty()) {
            return;
        }
        for (TranscriptEvidenceContext context : contexts) {
            document.add(spacedParagraph(prefix + defaultText(context.speaker()) + " " + timeRange(context.startTime(), context.endTime()), BODY_FONT));
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

    private void addBulletList(Document document, List<String> lines) throws Exception {
        if (lines == null || lines.isEmpty()) {
            document.add(spacedParagraph("N/A", BODY_FONT));
            document.add(blank());
            return;
        }
        for (String line : lines) {
            document.add(spacedParagraph("- " + defaultText(line), BODY_FONT));
        }
        document.add(blank());
    }

    private void addHeader(PdfPTable table, String... labels) {
        for (String label : labels) {
            PdfPCell cell = new PdfPCell(new Phrase(label, HEADING_FONT));
            cell.setBackgroundColor(new Color(235, 235, 235));
            table.addCell(cell);
        }
    }

    private PdfPCell cell(String text) {
        return new PdfPCell(new Phrase(defaultText(text), BODY_FONT));
    }

    private void addHeading(Document document, String text) throws Exception {
        Paragraph heading = new Paragraph(text, HEADING_FONT);
        heading.setSpacingBefore(8f);
        heading.setSpacingAfter(6f);
        document.add(heading);
    }

    private Paragraph spacedParagraph(String text, Font font) {
        Paragraph paragraph = new Paragraph(text == null ? "" : text, font);
        paragraph.setSpacingAfter(4f);
        return paragraph;
    }

    private Paragraph blank() {
        Paragraph paragraph = new Paragraph(" ");
        paragraph.setSpacingAfter(6f);
        return paragraph;
    }

    private void addRow(PdfPTable table, String field, String value) {
        PdfPCell fieldCell = new PdfPCell(new Phrase(defaultText(field), BODY_FONT));
        fieldCell.setBackgroundColor(new Color(245, 245, 245));
        table.addCell(fieldCell);
        table.addCell(new PdfPCell(new Phrase(defaultText(value), BODY_FONT)));
    }

    private <T> List<T> safeList(List<T> values) {
        return values == null ? List.of() : values;
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

    private static String firstNonBlank(String first, String second) {
        if (first != null && !first.isBlank()) {
            return first;
        }
        return second;
    }

    private static String safe(Object value) {
        return value == null ? "N/A" : String.valueOf(value);
    }

    private static String defaultText(String value) {
        return value == null || value.isBlank() ? "N/A" : value;
    }

    private String timeRange(double startTime, double endTime) {
        return "[" + startTime + "-" + endTime + "]";
    }

    private static BaseFont resolveUnicodeBaseFont() {
        for (String candidate : List.of(
                "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
                "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
                "C:/Windows/Fonts/arial.ttf",
                "C:/Windows/Fonts/segoeui.ttf"
        )) {
            try {
                if (Files.exists(Path.of(candidate))) {
                    return BaseFont.createFont(candidate, BaseFont.IDENTITY_H, BaseFont.EMBEDDED);
                }
            } catch (Exception ignored) {
                // Try the next platform font.
            }
        }
        try {
            return BaseFont.createFont(BaseFont.HELVETICA, BaseFont.WINANSI, BaseFont.NOT_EMBEDDED);
        } catch (Exception ex) {
            throw new IllegalStateException("Unable to initialize PDF font", ex);
        }
    }
}
