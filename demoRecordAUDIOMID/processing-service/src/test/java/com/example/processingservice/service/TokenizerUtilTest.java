package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class TokenizerUtilTest {

    @Test
    void normalizesVietnameseDiacritics() {
        assertEquals("hop", TokenizerUtil.normalizeToken("Hợp"));
        assertEquals("dong", TokenizerUtil.normalizeToken("đồng"));
    }

    @Test
    void tokenizesWordsWithRegex() {
        var tokens = TokenizerUtil.tokenizeForTfIdf("Hợp đồng luật sư");
        assertTrue(tokens.contains("hop"));
        assertTrue(tokens.contains("dong"));
    }
}
