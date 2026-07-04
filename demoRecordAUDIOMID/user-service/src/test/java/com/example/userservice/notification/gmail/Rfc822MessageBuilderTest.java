package com.example.userservice.notification.gmail;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import org.junit.jupiter.api.Test;

class Rfc822MessageBuilderTest {

    private final Rfc822MessageBuilder builder = new Rfc822MessageBuilder();
    private static final String FROM = "sender@gmail.com";

    @Test
    void buildBase64UrlRaw_encodesVietnamesePlainText() {
        String raw = builder.buildBase64UrlRaw(
                FROM,
                "Phuc Thanh Lam",
                "guest@example.com",
                "Mời xem cuộc họp",
                "Xin chào,\n\nBạn được mời xem cuộc họp \"Họp tuần\".\n— AudioMind",
                "<html><body><p>Họp tuần</p></body></html>",
                "reply@example.com"
        );

        assertThat(raw).isNotBlank();
        assertThat(raw).doesNotContain("+", "/");
        String decoded = new String(Base64.getUrlDecoder().decode(raw), StandardCharsets.UTF_8);
        assertThat(decoded).contains("guest@example.com");
        assertThat(decoded).contains("sender@gmail.com");
        assertThat(decoded).contains("reply@example.com");
        assertThat(decoded).contains("text/plain");
        assertThat(decoded).contains("text/html");
        assertThat(decoded).contains("multipart/alternative");
        assertThat(decoded).contains("charset=UTF-8");
        assertThat(decoded).doesNotContain("text/UTF-8");
        assertThat(decoded).contains("Message-ID:");
        assertThat(decoded).contains("@gmail.com>");
        assertThat(decoded).doesNotContain("@audiomind.local");
        assertThat(decoded).contains("H=E1=BB=8Dp tu=E1=BA=A7n");
    }

    @Test
    void buildBase64UrlRaw_plainOnlyWhenHtmlOmitted() {
        String raw = builder.buildBase64UrlRaw(
                FROM,
                "Phuc Thanh Lam",
                "guest@example.com",
                "Subject",
                "Plain only body",
                null
        );
        String decoded = new String(Base64.getUrlDecoder().decode(raw), StandardCharsets.UTF_8);
        assertThat(decoded).contains("text/plain");
        assertThat(decoded).doesNotContain("multipart/alternative");
    }

    @Test
    void buildBase64UrlRaw_rejectsBlankRecipient() {
        assertThatThrownBy(() -> builder.buildBase64UrlRaw(FROM, null, "", "Subject", "Body", null))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void buildBase64UrlRaw_handlesEmojiInBody() {
        String raw = builder.buildBase64UrlRaw(
                FROM,
                FROM,
                "a@b.com",
                "Hello",
                "Welcome 👋",
                null
        );
        String decoded = new String(Base64.getUrlDecoder().decode(raw), StandardCharsets.UTF_8);
        assertThat(decoded).contains("Welcome");
        assertThat(decoded).contains("sender@gmail.com");
    }
}
