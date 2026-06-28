package com.example.userservice.notification;

import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

/**
 * Builds multipart-ready share invite emails (plain text + Gmail-safe HTML).
 * Branding tokens are configurable via {@link NotificationProperties} for production deploy.
 */
@Component
@RequiredArgsConstructor
public class ShareInviteEmailComposer {

    private final NotificationProperties notificationProperties;

    public ShareInviteEmailContent composePendingInvite(
            String inviterLabel,
            String meetingTitle,
            String role,
            String registerUrl
    ) {
        String subject = inviterLabel + " đã chia sẻ cuộc họp với bạn";
        String brand = brandName();
        String plain = """
                Xin chào,

                %s đã mời bạn xem cuộc họp «%s» (quyền %s).

                Đăng ký bằng đúng email này để nhận quyền truy cập:
                %s

                Trân trọng,
                %s
                """.formatted(inviterLabel, meetingTitle, role, registerUrl, inviterLabel).trim();

        String html = buildHtml(
                inviterLabel,
                meetingTitle,
                role,
                "Đăng ký bằng đúng email bạn nhận thư này để được cấp quyền xem cuộc họp trong "
                        + brand + ".",
                "Đăng ký & nhận quyền truy cập",
                registerUrl
        );
        return new ShareInviteEmailContent(subject, plain, html);
    }

    public ShareInviteEmailContent composeMeetingShare(
            String inviteeLabel,
            String inviterLabel,
            String meetingTitle,
            String role,
            String meetingUrl
    ) {
        String subject = inviterLabel + " đã chia sẻ cuộc họp với bạn";
        String brand = brandName();
        String greeting = StringUtils.hasText(inviteeLabel) ? inviteeLabel : "bạn";
        String plain = """
                Xin chào %s,

                %s đã mời bạn xem cuộc họp «%s» (quyền %s).

                Mở cuộc họp:
                %s

                Trân trọng,
                %s
                """.formatted(greeting, inviterLabel, meetingTitle, role, meetingUrl, inviterLabel).trim();

        String html = buildHtml(
                inviterLabel,
                meetingTitle,
                role,
                "Bạn đã có tài khoản " + brand + ". Nhấn nút bên dưới để mở cuộc họp được chia sẻ.",
                "Mở cuộc họp",
                meetingUrl
        );
        return new ShareInviteEmailContent(subject, plain, html);
    }

    private String buildHtml(
            String inviterLabel,
            String meetingTitle,
            String role,
            String description,
            String ctaLabel,
            String actionUrl
    ) {
        String brand = escapeHtml(brandName());
        String accent = escapeHtml(accentColor());
        return """
                <!DOCTYPE html>
                <html lang="vi">
                <head>
                  <meta charset="UTF-8">
                  <meta name="viewport" content="width=device-width, initial-scale=1.0">
                  <title>%s</title>
                </head>
                <body style="margin:0;padding:0;background-color:#f4f6fb;font-family:Arial,Helvetica,sans-serif;">
                  <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background-color:#f4f6fb;padding:24px 12px;">
                    <tr>
                      <td align="center">
                        <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%%;max-width:600px;background-color:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e2e8f0;">
                          <tr>
                            <td style="background-color:%s;padding:28px 32px;color:#ffffff;">
                              <div style="font-size:12px;letter-spacing:0.08em;text-transform:uppercase;opacity:0.92;">%s</div>
                              <div style="font-size:22px;font-weight:700;line-height:1.35;margin-top:8px;">Lời mời xem cuộc họp</div>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:32px;color:#1e293b;font-size:15px;line-height:1.65;">
                              <p style="margin:0 0 16px;">Xin chào,</p>
                              <p style="margin:0 0 20px;"><strong style="color:#0f172a;">%s</strong> đã chia sẻ một cuộc họp với bạn.</p>
                              <table role="presentation" width="100%%" cellpadding="0" cellspacing="0" style="background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:10px;margin:0 0 20px;">
                                <tr>
                                  <td style="padding:18px 20px;">
                                    <div style="font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;">Cuộc họp</div>
                                    <div style="font-size:18px;font-weight:700;color:#0f172a;margin-top:6px;line-height:1.4;">%s</div>
                                    <div style="font-size:13px;color:#64748b;margin-top:10px;">Quyền truy cập: <strong style="color:#334155;">%s</strong></div>
                                  </td>
                                </tr>
                              </table>
                              <p style="margin:0 0 24px;color:#475569;">%s</p>
                              <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                                <tr>
                                  <td align="center" style="border-radius:8px;background-color:%s;">
                                    <a href="%s" style="display:inline-block;padding:14px 28px;color:#ffffff;text-decoration:none;font-weight:700;font-size:15px;line-height:1.2;">%s</a>
                                  </td>
                                </tr>
                              </table>
                              <p style="margin:0;font-size:13px;color:#64748b;line-height:1.5;">
                                Nếu nút không hoạt động, mở link sau:<br>
                                <a href="%s" style="color:%s;word-break:break-all;">%s</a>
                              </p>
                            </td>
                          </tr>
                          <tr>
                            <td style="padding:18px 32px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.5;color:#94a3b8;text-align:center;">
                              Email được gửi qua %s thay mặt %s
                            </td>
                          </tr>
                        </table>
                      </td>
                    </tr>
                  </table>
                </body>
                </html>
                """.formatted(
                brand,
                accent,
                brand,
                escapeHtml(inviterLabel),
                escapeHtml(meetingTitle),
                escapeHtml(role),
                escapeHtml(description),
                accent,
                escapeHtml(actionUrl),
                escapeHtml(ctaLabel),
                escapeHtml(actionUrl),
                accent,
                escapeHtml(actionUrl),
                brand,
                escapeHtml(inviterLabel)
        );
    }

    private String brandName() {
        return StringUtils.hasText(notificationProperties.getBrandName())
                ? notificationProperties.getBrandName().trim()
                : "AudioMind";
    }

    private String accentColor() {
        String color = notificationProperties.getBrandAccentColor();
        if (!StringUtils.hasText(color)) {
            return "#5b4bff";
        }
        String trimmed = color.trim();
        return trimmed.startsWith("#") ? trimmed : "#" + trimmed;
    }

    private String escapeHtml(String value) {
        if (value == null) {
            return "";
        }
        return value
                .replace("&", "&amp;")
                .replace("<", "&lt;")
                .replace(">", "&gt;")
                .replace("\"", "&quot;");
    }
}
