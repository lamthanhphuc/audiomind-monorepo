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

    public static final String EDUCATION_PROMPT_VERSION = "education-analysis-v1";
    public static final String EDUCATION_SCHEMA_VERSION = "education-study-v1";
    public static final String EDUCATION_FEATURE_SET = "education-study-v1";
    public static final String BUSINESS_PROMPT_VERSION = "gemini-business-v2";
    public static final String BUSINESS_SCHEMA_VERSION = "gemini-business-v2";

    private static final Set<String> ALLOWED = Set.of(
            "general",
            "it",
            "business",
            "education",
            "legal"
    );

    public record AnalysisVersions(
            String promptVersion,
            String schemaVersion,
            String analysisFeatureSet
    ) {
    }

    private DomainModes() {
    }

    public static String normalize(String value) {
        if (!StringUtils.hasText(value)) {
            return DEFAULT;
        }
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        return ALLOWED.contains(normalized) ? normalized : DEFAULT;
    }

    /**
     * Resolve prompt/schema/feature versions that must match AI-service
     * {@code resolve_analysis_versions} for cache identity.
     */
    public static AnalysisVersions resolveAnalysisVersions(String domainMode) {
        String normalized = normalize(domainMode);
        if ("education".equals(normalized)) {
            return new AnalysisVersions(
                    EDUCATION_PROMPT_VERSION,
                    EDUCATION_SCHEMA_VERSION,
                    EDUCATION_FEATURE_SET
            );
        }
        return new AnalysisVersions(
                BUSINESS_PROMPT_VERSION,
                BUSINESS_SCHEMA_VERSION,
                "grouped-action-plan-v1-" + normalized
        );
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
