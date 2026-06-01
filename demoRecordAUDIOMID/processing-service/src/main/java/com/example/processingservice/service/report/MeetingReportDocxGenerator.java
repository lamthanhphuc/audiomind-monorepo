package com.example.processingservice.service.report;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;

import org.apache.poi.xwpf.usermodel.ParagraphAlignment;
import org.apache.poi.xwpf.usermodel.XWPFDocument;
import org.apache.poi.xwpf.usermodel.XWPFParagraph;
import org.apache.poi.xwpf.usermodel.XWPFRun;
import org.apache.poi.xwpf.usermodel.XWPFTable;
import org.apache.poi.xwpf.usermodel.XWPFTableRow;
import org.springframework.stereotype.Component;

@Component
public class MeetingReportDocxGenerator {

    public byte[] generate(MeetingReportData report) {
        try (XWPFDocument doc = new XWPFDocument();
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {

            addTitle(doc, "Meeting Report");
            addParagraph(doc, "Meeting #" + safe(report.meetingMetadata().meetingId()));

            addHeading(doc, "Meeting Metadata");
            XWPFTable metadataTable = doc.createTable(1, 2);
            setCell(metadataTable.getRow(0), 0, "Field");
            setCell(metadataTable.getRow(0), 1, "Value");
            appendRow(metadataTable, "Meeting ID", safe(report.meetingMetadata().meetingId()));
            appendRow(metadataTable, "Title", report.meetingMetadata().title());
            appendRow(metadataTable, "Created At", report.meetingMetadata().createdAt());
            appendRow(metadataTable, "Recognition Mode", report.meetingMetadata().recognitionMode());
            appendRow(metadataTable, "Detected Transcript Language", report.meetingMetadata().detectedTranscriptLanguage());
            appendRow(metadataTable, "Status", report.meetingMetadata().status());
            appendRow(metadataTable, "Original File", report.meetingMetadata().originalFileName());
            appendRow(metadataTable, "Owner", report.meetingMetadata().ownerUserId());
            appendRow(metadataTable, "File Size", report.meetingMetadata().fileSize());

            addHeading(doc, "Executive Summary");
            addParagraph(doc, defaultText(report.businessSummary()));

            addHeading(doc, "Key Decisions");
            addBulletList(doc, report.decisions(), report.analysisAvailable());

            addHeading(doc, "Action Items");
            addActionItems(doc, report.actionItems(), report.analysisAvailable());

            addHeading(doc, "Risks/Blockers");
            addBulletList(doc, merge(report.risks(), report.blockers()), report.analysisAvailable());

            addHeading(doc, "Next Steps");
            addBulletList(doc, report.nextSteps(), report.analysisAvailable());

            addHeading(doc, "Analyzed Highlights Table");
            addParagraph(doc, "Highlights are derived from saved analysis and linked to transcript evidence when available.");
            if (report.analyzedHighlightRows() == null || report.analyzedHighlightRows().isEmpty()) {
                addParagraph(doc, "No analyzed highlights available.");
            } else {
                XWPFTable highlightsTable = doc.createTable(1, 6);
                setCell(highlightsTable.getRow(0), 0, "#");
                setCell(highlightsTable.getRow(0), 1, "Category");
                setCell(highlightsTable.getRow(0), 2, "Business meaning");
                setCell(highlightsTable.getRow(0), 3, "Owner");
                setCell(highlightsTable.getRow(0), 4, "Due date");
                setCell(highlightsTable.getRow(0), 5, "Evidence / Note");
                for (MeetingReportData.AnalyzedHighlightRow row : report.analyzedHighlightRows()) {
                    XWPFTableRow tableRow = highlightsTable.createRow();
                    setCell(tableRow, 0, String.valueOf(row.index()));
                    setCell(tableRow, 1, row.category());
                    setCell(tableRow, 2, row.businessMeaning());
                    setCell(tableRow, 3, row.owner());
                    setCell(tableRow, 4, row.dueDate());
                    setCell(tableRow, 5, row.evidenceOrNote());
                }
            }

            addHeading(doc, "Analysis Metadata");
            XWPFTable analysisMetadataTable = doc.createTable(1, 2);
            setCell(analysisMetadataTable.getRow(0), 0, "Field");
            setCell(analysisMetadataTable.getRow(0), 1, "Value");
            appendRow(analysisMetadataTable, "Status", report.analysisMetadata().status());
            appendRow(analysisMetadataTable, "Prompt Version", report.analysisMetadata().promptVersion());
            appendRow(analysisMetadataTable, "Schema Version", report.analysisMetadata().schemaVersion());
            appendRow(analysisMetadataTable, "Transcript Hash", report.analysisMetadata().transcriptHash());
            appendRow(analysisMetadataTable, "Confidence", report.analysisMetadata().confidence());
            appendRow(analysisMetadataTable, "Domain Mode", report.analysisMetadata().domainMode());
            appendRow(analysisMetadataTable, "Source", report.analysisMetadata().source());

            addHeading(doc, "Appendix A — Transcript Evidence Preview");
            addParagraph(doc, "This section shows a short best-effort readable preview from saved STT output. Obvious repeated fragments may be collapsed for readability; full canonical transcript cleanup is planned separately.");
            if (report.transcriptPreviewLimited()) {
                addParagraph(doc, "Preview limited because the saved transcript contains overlapping STT fragments.");
            }
            XWPFTable rawTable = doc.createTable(1, 4);
            setCell(rawTable.getRow(0), 0, "#");
            setCell(rawTable.getRow(0), 1, "Time");
            setCell(rawTable.getRow(0), 2, "Speaker");
            setCell(rawTable.getRow(0), 3, "Raw transcript");
            for (MeetingReportData.RawTranscriptRow row : report.rawTranscriptRows()) {
                XWPFTableRow tableRow = rawTable.createRow();
                setCell(tableRow, 0, String.valueOf(row.index()));
                setCell(tableRow, 1, combineTimeRange(row.startTime(), row.endTime()));
                setCell(tableRow, 2, row.speaker());
                setCell(tableRow, 3, row.rawText());
            }

            doc.write(out);
            return out.toByteArray();
        } catch (IOException ex) {
            throw new IllegalStateException("Unable to generate meeting report DOCX", ex);
        }
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

    private void addBulletList(XWPFDocument doc, List<String> lines, boolean analysisAvailable) {
        if (lines == null || lines.isEmpty()) {
            addParagraph(doc, analysisAvailable ? "N/A" : "Analysis not available");
            return;
        }
        for (String line : lines) {
            addParagraph(doc, "- " + defaultText(line));
        }
    }

    private void addActionItems(XWPFDocument doc, List<MeetingReportData.ReportActionItem> items, boolean analysisAvailable) {
        if (items == null || items.isEmpty()) {
            addParagraph(doc, analysisAvailable ? "N/A" : "Analysis not available");
            return;
        }

        for (MeetingReportData.ReportActionItem item : items) {
            String text = "%s (owner: %s, due: %s)".formatted(
                    defaultText(item.task()),
                    defaultText(item.owner()),
                    defaultText(item.dueDate())
            );
            addParagraph(doc, "- " + text);
            if (item.evidence() != null && !item.evidence().isBlank()) {
                addParagraph(doc, "  note: " + item.evidence());
            }
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
        if ((first == null || first.isEmpty()) && (second == null || second.isEmpty())) {
            return List.of();
        }
        java.util.ArrayList<String> merged = new java.util.ArrayList<>();
        if (first != null) {
            merged.addAll(first);
        }
        if (second != null) {
            merged.addAll(second);
        }
        return merged;
    }

    private String defaultText(String value) {
        if (value == null || value.isBlank()) {
            return "N/A";
        }
        return value;
    }

    private String safe(Object value) {
        return value == null ? "N/A" : String.valueOf(value);
    }

    private String combineTimeRange(String start, String end) {
        String left = defaultText(start);
        String right = defaultText(end);
        if ("N/A".equals(left) && "N/A".equals(right)) {
            return "N/A";
        }
        return left + "–" + right;
    }
}
