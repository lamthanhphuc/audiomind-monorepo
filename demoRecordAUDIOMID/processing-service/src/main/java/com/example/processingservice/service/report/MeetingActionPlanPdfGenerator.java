package com.example.processingservice.service.report;

import com.lowagie.text.Document;
import com.lowagie.text.Font;
import com.lowagie.text.FontFactory;
import com.lowagie.text.PageSize;
import com.lowagie.text.Paragraph;
import com.lowagie.text.Phrase;
import com.lowagie.text.pdf.PdfPCell;
import com.lowagie.text.pdf.PdfPTable;
import com.lowagie.text.pdf.PdfWriter;
import java.awt.Color;
import java.io.ByteArrayOutputStream;
import java.util.List;
import org.springframework.stereotype.Component;

@Component
public class MeetingActionPlanPdfGenerator {

    private static final Font TITLE_FONT = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 18);
    private static final Font HEADING_FONT = FontFactory.getFont(FontFactory.HELVETICA_BOLD, 12);
    private static final Font BODY_FONT = FontFactory.getFont(FontFactory.HELVETICA, 10);

    public byte[] generate(MeetingActionPlanData actionPlan) {
        try (ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Document document = new Document(PageSize.A4, 48, 48, 54, 54);
            PdfWriter.getInstance(document, out);
            document.open();

            document.add(new Paragraph("Meeting Action Plan", TITLE_FONT));
            document.add(spacedParagraph("Meeting #" + safe(actionPlan.meeting().meetingId()), BODY_FONT));
            document.add(blank());

            addHeading(document, "Meeting Metadata");
            PdfPTable metadata = new PdfPTable(2);
            metadata.setWidthPercentage(100);
            addRow(metadata, "Title", actionPlan.meeting().title());
            addRow(metadata, "Created At", actionPlan.meeting().createdAt());
            addRow(metadata, "Language", actionPlan.meeting().language());
            addRow(metadata, "Status", actionPlan.meeting().status());
            document.add(metadata);
            document.add(blank());

            addHeading(document, "Summary");
            document.add(spacedParagraph(defaultText(actionPlan.summary()), BODY_FONT));
            document.add(blank());

            addHeading(document, "Action Items");
            if (actionPlan.actionItems() == null || actionPlan.actionItems().isEmpty()) {
                document.add(spacedParagraph("No action items available.", BODY_FONT));
            } else {
                PdfPTable table = new PdfPTable(5);
                table.setWidthPercentage(100);
                addHeader(table, "#", "Task", "Owner", "Due", "Priority");
                int index = 1;
                for (MeetingActionPlanData.ActionItem item : actionPlan.actionItems()) {
                    table.addCell(cell(String.valueOf(index++)));
                    table.addCell(cell(defaultText(item.task())));
                    table.addCell(cell(defaultText(item.owner())));
                    table.addCell(cell(defaultText(item.dueDate() != null ? item.dueDate() : item.deadline())));
                    table.addCell(cell(defaultText(item.priority())));
                }
                document.add(table);
            }

            document.close();
            return out.toByteArray();
        } catch (Exception ex) {
            throw new IllegalStateException("Failed to generate action plan PDF", ex);
        }
    }

    private void addHeader(PdfPTable table, String... labels) {
        for (String label : labels) {
            PdfPCell cell = new PdfPCell(new Phrase(label, HEADING_FONT));
            cell.setBackgroundColor(new Color(235, 235, 235));
            table.addCell(cell);
        }
    }

    private PdfPCell cell(String text) {
        return new PdfPCell(new Phrase(text, BODY_FONT));
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
}
