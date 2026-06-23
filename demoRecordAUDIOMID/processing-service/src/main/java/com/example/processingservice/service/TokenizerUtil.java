package com.example.processingservice.service;

import java.text.Normalizer;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Shared tokenizer for TF-IDF (Epic 3 §2.4) — Java port of ai-service tokenizer.py.
 */
public final class TokenizerUtil {

    private static final Pattern TOKEN_PATTERN = Pattern.compile("\\b\\w+\\b", Pattern.UNICODE_CHARACTER_CLASS);
    private static final Pattern COMBINING_MARK_PATTERN = Pattern.compile("\\p{M}+");

    private TokenizerUtil() {
    }

    public static String normalizeToken(String text) {
        if (text == null || text.isBlank()) {
            return "";
        }
        String lower = text.toLowerCase(Locale.ROOT).replace('\u0111', 'd').replace('\u0110', 'D');
        String decomposed = Normalizer.normalize(lower, Normalizer.Form.NFD);
        String stripped = COMBINING_MARK_PATTERN.matcher(decomposed).replaceAll("");
        return stripped.trim();
    }

    public static List<String> tokenizeForTfIdf(String text) {
        if (text == null || text.isBlank()) {
            return List.of();
        }
        List<String> tokens = new ArrayList<>();
        Matcher matcher = TOKEN_PATTERN.matcher(text);
        while (matcher.find()) {
            String normalized = normalizeToken(matcher.group());
            if (!normalized.isEmpty()) {
                tokens.add(normalized);
            }
        }
        return tokens;
    }
}
