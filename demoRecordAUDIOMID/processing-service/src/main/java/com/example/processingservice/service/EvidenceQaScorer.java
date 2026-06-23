package com.example.processingservice.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;
import com.fasterxml.jackson.databind.JsonNode;

/**
 * Evidence QA scoring (Epic 3 §5.4).
 */
public final class EvidenceQaScorer {

    private static final Logger log = LoggerFactory.getLogger(EvidenceQaScorer.class);

    private EvidenceQaScorer() {
    }

    public static Map<String, Object> mapStabilizedToCanonical(
            Long meetingId,
            Map<String, Object> stabilizedRow,
            TranscriptQualityContext qualityContext
    ) {
        if (qualityContext == null || !qualityContext.isReady()) {
            return null;
        }
        String segmentId = firstNonBlank(stabilizedRow.get("segmentId"), stabilizedRow.get("segment_id"));
        if (!segmentId.isBlank()) {
            for (Map<String, Object> canonical : qualityContext.canonicalTranscriptRows()) {
                String canonId = firstNonBlank(canonical.get("segmentId"), canonical.get("segment_id"));
                if (segmentId.equals(canonId)) {
                    return canonical;
                }
            }
        }
        double stabStart = parseTime(stabilizedRow.get("startTime"), stabilizedRow.get("start_time"));
        double stabEnd = parseTime(stabilizedRow.get("endTime"), stabilizedRow.get("end_time"));
        String speaker = firstNonBlank(stabilizedRow.get("speaker"));
        Map<String, Object> best = null;
        double bestOverlap = 0d;
        for (Map<String, Object> canonical : qualityContext.canonicalTranscriptRows()) {
            double canonStart = parseTime(canonical.get("startTime"), canonical.get("start_time"));
            double canonEnd = parseTime(canonical.get("endTime"), canonical.get("end_time"));
            double overlap = overlapRatio(stabStart, stabEnd, canonStart, canonEnd);
            if (overlap >= 0.5d && overlap > bestOverlap) {
                bestOverlap = overlap;
                best = canonical;
            }
        }
        if (best == null) {
            log.info(
                    "event=TRANSCRIPT_QUALITY_SEGMENT_MAP_MISSING meetingId={} stabilizedStart={} stabilizedEnd={} speaker={}",
                    meetingId,
                    stabStart,
                    stabEnd,
                    speaker
            );
        }
        return best;
    }

    public static ScoredEvidence scoreMatch(
            Long meetingId,
            String queryTerm,
            Map<String, Object> canonicalRow,
            int canonicalIndex,
            TranscriptQualityContext qualityContext,
            JsonNode evidencePolicy,
            boolean evidenceQaEnabled
    ) {
        if (!evidenceQaEnabled || canonicalRow == null || qualityContext == null || !qualityContext.isReady()) {
            return ScoredEvidence.unscored();
        }
        Map<String, Object> stats = qualityContext.evidenceStats();
        if (stats == null || stats.isEmpty()) {
            log.info(
                    "event=EVIDENCE_QA_STATS_MISSING meetingId={} term={} reason=evidence_stats_null",
                    meetingId,
                    queryTerm
            );
            return ScoredEvidence.unverified(0d);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> idfMap = stats.get("idf") instanceof Map<?, ?> map
                ? (Map<String, Object>) map
                : Map.of();
        if (!idfMap.containsKey(queryTerm)) {
            log.info(
                    "event=EVIDENCE_QA_STATS_MISSING meetingId={} term={} reason=idf_key_missing",
                    meetingId,
                    queryTerm
            );
            return ScoredEvidence.unverified(0d);
        }
        @SuppressWarnings("unchecked")
        Map<String, Object> tfMap = canonicalRow.get("termFrequency") instanceof Map<?, ?> tf
                ? (Map<String, Object>) tf
                : canonicalRow.get("term_frequency") instanceof Map<?, ?> tfSnake
                        ? (Map<String, Object>) tfSnake
                        : Map.of();
        if (!tfMap.containsKey(queryTerm)) {
            log.info(
                    "event=EVIDENCE_QA_STATS_MISSING meetingId={} term={} reason=term_frequency_missing",
                    meetingId,
                    queryTerm
            );
            return ScoredEvidence.unverified(0d);
        }

        double idf = toDouble(idfMap.get(queryTerm));
        double tf = toDouble(tfMap.get(queryTerm));
        int totalSegments = toInt(stats.get("segmentCount"), toInt(stats.get("segment_count"), qualityContext.canonicalTranscriptRows().size()));
        double positionNorm = canonicalIndex / Math.max(1d, totalSegments - 1d);
        double positionNormDecay = evidencePolicy.path("positionNormDecay").asDouble(0.5);
        double speakerBoost = evidencePolicy.path("speakerBoost").asDouble(1.1);
        double minScore = evidencePolicy.path("minScore").asDouble(0.35);

        double rawScore = idf * tf * (1d - positionNorm * positionNormDecay) * speakerBoost;
        double clamped = Math.min(1d, Math.max(0d, rawScore));
        String status;
        if (clamped >= minScore) {
            status = "verified";
            log.info(
                    "event=EVIDENCE_QA_VERIFIED meetingId={} term={} score={}",
                    meetingId,
                    queryTerm,
                    clamped
            );
        } else if (clamped >= minScore * 0.7d) {
            status = "weak";
            log.info(
                    "event=EVIDENCE_QA_WEAK meetingId={} term={} score={}",
                    meetingId,
                    queryTerm,
                    clamped
            );
        } else {
            status = "unverified";
        }
        return new ScoredEvidence(clamped, status, buildDedupeKey(canonicalRow));
    }

    public static String buildDedupeKey(Map<String, Object> row) {
        String speaker = firstNonBlank(row.get("speaker"));
        double start = parseTime(row.get("startTime"), row.get("start_time"));
        double end = parseTime(row.get("endTime"), row.get("end_time"));
        String text = firstNonBlank(row.get("text"));
        String textHash = textHashPrefix(text);
        return "SPEAKER_" + speaker + ":" + start + ":" + end + ":" + textHash;
    }

    public static List<TranscriptEvidenceMatch> dedupeMatches(
            Long meetingId,
            List<TranscriptEvidenceMatch> matches,
            double dedupeWindowSeconds
    ) {
        List<TranscriptEvidenceMatch> kept = new java.util.ArrayList<>();
        for (TranscriptEvidenceMatch match : matches) {
            boolean duplicate = false;
            for (TranscriptEvidenceMatch existing : kept) {
                if (match.speaker().equals(existing.speaker())
                        && Math.abs(match.startTime() - existing.startTime()) <= dedupeWindowSeconds) {
                    duplicate = true;
                    if (match.score() > existing.score()) {
                        kept.remove(existing);
                        kept.add(match);
                    }
                    log.info(
                            "event=EVIDENCE_QA_DEDUPED meetingId={} dedupeKey={}",
                            meetingId,
                            match.dedupeKey()
                    );
                    break;
                }
            }
            if (!duplicate) {
                kept.add(match);
            }
        }
        return kept;
    }

    private static double overlapRatio(double aStart, double aEnd, double bStart, double bEnd) {
        double intersection = Math.max(0d, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));
        double minDuration = Math.max(0.001d, Math.min(aEnd - aStart, bEnd - bStart));
        return intersection / minDuration;
    }

    private static String textHashPrefix(String text) {
        String normalized = TokenizerUtil.normalizeToken(text);
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            String hex = HexFormat.of().formatHex(digest.digest(normalized.getBytes(StandardCharsets.UTF_8)));
            return hex.length() <= 8 ? hex : hex.substring(0, 8);
        } catch (NoSuchAlgorithmException ex) {
            return Integer.toHexString(normalized.hashCode()).substring(0, 8);
        }
    }

    private static String firstNonBlank(Object... values) {
        if (values == null) {
            return "";
        }
        for (Object value : values) {
            if (value == null) {
                continue;
            }
            String text = String.valueOf(value).trim();
            if (!text.isBlank()) {
                return text;
            }
        }
        return "";
    }

    private static double parseTime(Object... values) {
        for (Object value : values) {
            if (value == null) {
                continue;
            }
            try {
                return Double.parseDouble(String.valueOf(value).trim());
            } catch (NumberFormatException ignored) {
                // continue
            }
        }
        return 0d;
    }

    private static double toDouble(Object value) {
        if (value instanceof Number number) {
            return number.doubleValue();
        }
        try {
            return Double.parseDouble(String.valueOf(value));
        } catch (NumberFormatException ex) {
            return 0d;
        }
    }

    private static int toInt(Object value, int fallback) {
        if (value instanceof Number number) {
            return number.intValue();
        }
        try {
            return Integer.parseInt(String.valueOf(value));
        } catch (NumberFormatException ex) {
            return fallback;
        }
    }

    public record ScoredEvidence(double score, String verificationStatus, String dedupeKey) {
        static ScoredEvidence unscored() {
            return new ScoredEvidence(0d, null, null);
        }

        static ScoredEvidence unverified(double score) {
            return new ScoredEvidence(score, "unverified", null);
        }
    }
}
