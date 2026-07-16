package com.example.processingservice.util;

import java.util.Locale;
import java.util.Map;
import java.util.Set;

import org.springframework.util.StringUtils;

/**
 * Shared domain-mode normalization for AI analysis cache / prompt identity.
 */
public final class DomainModes {

    public static final String DEFAULT = "general";

    private static final Set<String> ALLOWED = Set.of(
            "general",
            "it",
            "business",
            "education",
            "legal"
    );

    private DomainModes() {
    }

    public static String normalize(String value) {
        if (!StringUtils.hasText(value)) {
            return DEFAULT;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return ALLOWED.contains(normalized) ? normalized : DEFAULT;
    }

    public static String fromAnalysisPayload(Map<String, Object> analysisPayload) {
        if (analysisPayload == null || analysisPayload.isEmpty()) {
            return DEFAULT;
        }
        Object domain = analysisPayload.get("domainMode");
        if (domain == null) {
            domain = analysisPayload.get("domain_mode");
        }
        if (domain == null) {
            return DEFAULT;
        }
        return normalize(String.valueOf(domain));
    }

    public static String firstNonBlankNormalized(Object... candidates) {
        if (candidates == null) {
            return DEFAULT;
        }
        for (Object candidate : candidates) {
            if (candidate == null) {
                continue;
            }
            String text = String.valueOf(candidate).trim();
            if (!text.isEmpty()) {
                return normalize(text);
            }
        }
        return DEFAULT;
    }
}
