package com.example.userservice.notification;

import org.springframework.util.StringUtils;

public final class HumanReadableLabel {

    private HumanReadableLabel() {
    }

    public static String sanitize(String value) {
        if (!StringUtils.hasText(value)) {
            return value;
        }
        String trimmed = value.trim();
        String withoutClassPrefix = trimmed.replaceFirst("^[0-9]{1,2}[A-Za-z][0-9]?-\\d+\\s+", "");
        if (StringUtils.hasText(withoutClassPrefix)) {
            return withoutClassPrefix.trim();
        }
        return trimmed;
    }
}
