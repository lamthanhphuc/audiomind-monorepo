package com.example.processingservice.service.report;

import com.lowagie.text.Document;
import com.lowagie.text.Font;
import com.lowagie.text.PageSize;
import com.lowagie.text.Paragraph;
import com.lowagie.text.Phrase;
import com.lowagie.text.pdf.PdfPCell;
import com.lowagie.text.pdf.PdfPTable;
import com.lowagie.text.pdf.PdfWriter;
import com.lowagie.text.pdf.BaseFont;
import java.awt.Color;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class MeetingReportPdfGenerator {

    private static final BaseFont UNICODE_BASE_FONT = resolveUnicodeBaseFont();
    private static final Font TITLE_FONT = new Font(UNICODE_BASE_FONT, 18, Font.BOLD);
    private static final Font HEADING_FONT = new Font(UNICODE_BASE_FONT, 12, Font.BOLD);
    private static final Font BODY_FONT = new Font(UNICODE_BASE_FONT, 10, Font.NORMAL);

    public byte[] generate(MeetingReportData report) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Document document = new Document(PageSize.A4, 48, 48, 54, 54);
            PdfWriter.getInstance(document, out);
            document.open();

            document.add(new Paragraph("Báo cáo phân tích", TITLE_FONT));
            document.add(spacedParagraph("Meeting #" + safe(report.meetingMetadata().meetingId()), BODY_FONT));
            document.add(blank());

            addHeading(document, "Meeting Metadata");
            addMetadataTable(document, report);

            addHeading(document, "Executive Summary");
            document.add(spacedParagraph(defaultText(report.businessSummary()), BODY_FONT));

            addBulletSection(document, "Keywords", report.keywords(), report.analysisAvailable());
            addBulletSection(document, "Technical Terms", report.technicalTerms(), report.analysisAvailable());
            addBulletSection(document, "Key Decisions", report.decisions(), report.analysisAvailable());
            addBulletSection(document, "Pain Points", report.painPoints(), report.analysisAvailable());
            addBulletSection(document, "Nội dung học tập", report.educationStudyHighlights(), report.analysisAvailable());
            addActionItems(document, report.actionItems(), report.analysisAvailable());
            addBulletSection(document, "Risks/Blockers", merge(report.risks(), report.blockers()), report.analysisAvailable());
            addBulletSection(document, "Next Steps", report.nextSteps(), report.analysisAvailable());
            addImpactSummary(document, report.impactSummary(), report.analysisAvailable());

            addHeading(document, "Transcript Preview");
            if (report.rawTranscriptRows() == null || report.rawTranscriptRows().isEmpty()) {
                document.add(spacedParagraph("No transcript preview available.", BODY_FONT));
            } else {
                for (MeetingReportData.RawTranscriptRow row : report.rawTranscriptRows()) {
                    String line = String.format(
                            "%d. [%s-%s] %s: %s",
                            row.index(),
                            row.startTime(),
                            row.endTime(),
                            row.speaker(),
                            row.rawText()
                    );
                    document.add(spacedParagraph(line, BODY_FONT));
                }
                if (report.transcriptPreviewLimited()) {
                    document.add(spacedParagraph("(Preview limited)", BODY_FONT));
                }
            }

            document.close();
            return out.toByteArray();
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to generate meeting report PDF", ex);
        }
    }

    private void addMetadataTable(Document document, MeetingReportData report) throws Exception {
        PdfPTable table = new PdfPTable(2);
        table.setWidthPercentage(100);
        addRow(table, "Title", report.meetingMetadata().title());
        addRow(table, "Created At", report.meetingMetadata().createdAt());
        addRow(table, "Status", report.meetingMetadata().status());
        addRow(table, "Language", report.meetingMetadata().detectedTranscriptLanguage());
        addRow(table, "Owner", report.meetingMetadata().ownerUserId());
        document.add(table);
        document.add(blank());
    }

    private void addActionItems(Document document, List<MeetingReportData.ReportActionItem> items, boolean analysisAvailable) throws Exception {
        addHeading(document, "Action Items");
        if (!analysisAvailable || items == null || items.isEmpty()) {
            document.add(spacedParagraph("No action items available.", BODY_FONT));
            document.add(blank());
            return;
        }
        for (MeetingReportData.ReportActionItem item : items) {
            String line = "- " + defaultText(item.task());
            if (item.owner() != null && !item.owner().isBlank()) {
                line += " (owner: " + item.owner() + ")";
            }
            if (item.dueDate() != null && !item.dueDate().isBlank()) {
                line += " [due: " + item.dueDate() + "]";
            }
            if (item.priority() != null && !item.priority().isBlank()) {
                line += " [priority: " + item.priority() + "]";
            }
            if (item.status() != null && !item.status().isBlank()) {
                line += " [status: " + item.status() + "]";
            }
            document.add(spacedParagraph(line, BODY_FONT));
            if (item.evidence() != null && !item.evidence().isBlank()) {
                document.add(spacedParagraph("  note: " + item.evidence(), BODY_FONT));
            }
        }
        document.add(blank());
    }

    private void addBulletSection(Document document, String title, List<String> items, boolean analysisAvailable) throws Exception {
        addHeading(document, title);
        if (!analysisAvailable || items == null || items.isEmpty()) {
            document.add(spacedParagraph("Not available.", BODY_FONT));
        } else {
            for (String item : items) {
                document.add(spacedParagraph("- " + defaultText(item), BODY_FONT));
            }
        }
        document.add(blank());
    }

    private void addImpactSummary(Document document, MeetingReportData.ImpactSummary impact, boolean analysisAvailable) throws Exception {
        addHeading(document, "Impact");
        if (!analysisAvailable || impact == null) {
            document.add(spacedParagraph("Not available.", BODY_FONT));
            document.add(blank());
            return;
        }
        document.add(spacedParagraph("- Business: " + defaultText(impact.businessImpact()), BODY_FONT));
        document.add(spacedParagraph("- Customer: " + defaultText(impact.customerImpact()), BODY_FONT));
        document.add(spacedParagraph("- Technical: " + defaultText(impact.technicalImpact()), BODY_FONT));
        document.add(spacedParagraph("- Confidence: " + defaultText(impact.confidence()), BODY_FONT));
        document.add(blank());
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

    private static String safe(Object value) {
        return value == null ? "" : String.valueOf(value);
    }

    private static String defaultText(String value) {
        return value == null || value.isBlank() ? "(empty)" : value.trim();
    }

    private static List<String> merge(List<String> left, List<String> right) {
        if (left == null || left.isEmpty()) {
            return right == null ? List.of() : right;
        }
        if (right == null || right.isEmpty()) {
            return left;
        }
        return java.util.stream.Stream.concat(left.stream(), right.stream()).toList();
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
