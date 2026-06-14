package com.example.processingservice.service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Pattern;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import com.example.processingservice.controller.dto.TranscriptEvidenceContext;
import com.example.processingservice.controller.dto.TranscriptEvidenceMatch;
import com.example.processingservice.controller.dto.TranscriptSearchResponse;

@Service
public class TranscriptEvidenceSearchService {
    private static final int MAX_TRANSCRIPT_SEARCH_LIMIT = 50;
    private static final int MAX_TRANSCRIPT_SEARCH_CONTEXT = 3;
    private static final int MAX_TRANSCRIPT_SEARCH_MATCH_TEXT_CHARS = 800;
    private static final int MAX_TRANSCRIPT_SEARCH_CONTEXT_TEXT_CHARS = 400;
    private static final Pattern SEARCH_COMBINING_MARK_PATTERN = Pattern.compile("\\p{M}+");
    private static final Pattern SEARCH_SEPARATOR_PATTERN = Pattern.compile("[^\\p{IsAlphabetic}\\p{IsDigit}]+");
    private static final Pattern SEARCH_WHITESPACE_PATTERN = Pattern.compile("\\s+");

    public TranscriptSearchResponse searchTranscriptEvidence(
            Long meetingId,
            List<Map<String, Object>> readableRows,
            String query,
            String transcriptMode,
            String canonicalTranscriptHash,
            String canonicalTranscriptVersion,
            int limit,
            int context
    ) {
        String trimmedQuery = query == null ? "" : query.trim();
        String normalizedQuery = normalizeSearchText(trimmedQuery);
        List<String> queryTokens = searchTokens(normalizedQuery);
        if (normalizedQuery.length() < 2 || queryTokens.stream().anyMatch(token -> token.length() < 2)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "QUERY_TOO_SHORT");
        }
        int effectiveLimit = normalizeLimit(limit);
        int effectiveContext = normalizeContext(context);
        List<SearchableTranscriptSegment> segments = toSearchableTranscriptSegments(meetingId, readableRows);
        List<SearchCandidate> candidates = new ArrayList<>();

        for (SearchableTranscriptSegment segment : segments) {
            SearchMatch searchMatch = matchSearchSegment(segment, normalizedQuery, queryTokens);
            if (searchMatch != null) {
                candidates.add(new SearchCandidate(segment, searchMatch));
            }
        }

        candidates.sort(Comparator
                .comparingDouble((SearchCandidate candidate) -> candidate.searchMatch().score()).reversed()
                .thenComparingInt(candidate -> candidate.segment().index()));

        List<TranscriptEvidenceMatch> matches = new ArrayList<>();
        int resultCount = Math.min(effectiveLimit, candidates.size());
        for (int i = 0; i < resultCount; i++) {
            matches.add(toTranscriptEvidenceMatch(
                    meetingId,
                    normalizedQuery,
                    candidates.get(i),
                    segments,
                    effectiveContext,
                    i + 1
            ));
        }

        return new TranscriptSearchResponse(
                meetingId,
                trimmedQuery,
                normalizedQuery,
                transcriptMode,
                canonicalTranscriptHash,
                canonicalTranscriptVersion,
                matches
        );
    }

    public String normalizeSearchText(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        String lower = value.toLowerCase(Locale.ROOT).replace('\u0111', 'd');
        String decomposed = Normalizer.normalize(lower, Normalizer.Form.NFD);
        String withoutMarks = SEARCH_COMBINING_MARK_PATTERN.matcher(decomposed).replaceAll("");
        String withSeparators = SEARCH_SEPARATOR_PATTERN.matcher(withoutMarks).replaceAll(" ");
        return SEARCH_WHITESPACE_PATTERN.matcher(withSeparators).replaceAll(" ").trim();
    }

    public int normalizeLimit(int limit) {
        if (limit <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_SEARCH_LIMIT");
        }
        return Math.min(limit, MAX_TRANSCRIPT_SEARCH_LIMIT);
    }

    public int normalizeContext(int context) {
        if (context < 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "INVALID_SEARCH_CONTEXT");
        }
        return Math.min(context, MAX_TRANSCRIPT_SEARCH_CONTEXT);
    }

    public String queryHashPrefix(String query) {
        String hash = computeHash(query == null ? "" : query);
        return hash.length() <= 12 ? hash : hash.substring(0, 12);
    }

    public int queryTokenCount(String query) {
        return searchTokens(normalizeSearchText(query)).size();
    }

    private List<SearchableTranscriptSegment> toSearchableTranscriptSegments(
            Long meetingId,
            List<Map<String, Object>> readableRows
    ) {
        if (readableRows == null || readableRows.isEmpty()) {
            return List.of();
        }
        List<SearchableTranscriptSegment> segments = new ArrayList<>();
        for (Map<String, Object> row : readableRows) {
            if (row == null) {
                continue;
            }
            String text = firstNonBlank(row.get("text"));
            if (text.isBlank()) {
                continue;
            }
            int index = segments.size();
            double startTime = parseTimeSeconds(row.get("start_time"), row.get("startTime"), row.get("start"));
            double endTime = resolveEnd(
                    startTime,
                    parseTimeSeconds(row.get("end_time"), row.get("endTime"), row.get("end"))
            );
            String speaker = firstNonBlank(row.get("speaker"), row.get("speakerName"), row.get("speaker_name"));
            if (speaker.isBlank()) {
                speaker = "Speaker " + (index + 1);
            }
            String segmentId = firstNonBlank(row.get("segment_id"), row.get("segmentId"), row.get("id"));
            if (segmentId.isBlank()) {
                segmentId = generatedSegmentId(meetingId, index, startTime, speaker);
            }
            segments.add(new SearchableTranscriptSegment(
                    index,
                    segmentId,
                    speaker,
                    startTime,
                    endTime,
                    text,
                    normalizeSearchText(text)
            ));
        }
        return segments;
    }

    private SearchMatch matchSearchSegment(
            SearchableTranscriptSegment segment,
            String normalizedQuery,
            List<String> queryTokens
    ) {
        if (segment.normalizedText().isBlank()) {
            return null;
        }
        List<String> segmentTokens = searchTokens(segment.normalizedText());
        if (segmentTokens.isEmpty() || queryTokens.isEmpty()) {
            return null;
        }

        int queryCharacterCount = normalizedQuery.replace(" ", "").length();
        int phrasePosition = boundaryPhrasePosition(segment.normalizedText(), normalizedQuery);
        boolean phraseMatch = phrasePosition >= 0 && queryCharacterCount >= 4;
        int tokenHits = countTokenHits(segmentTokens, queryTokens, queryCharacterCount);
        boolean tokenMatch = tokenHits >= queryTokens.size();
        if (!phraseMatch && !tokenMatch) {
            return null;
        }
        String matchType = phraseMatch ? "phrase" : "token";
        double quality = phraseMatch ? 1000d : 500d;
        double tokenScore = tokenHits * 10d;
        double positionScore = phraseMatch ? Math.max(0d, 50d - phrasePosition) : 0d;
        double lengthScore = Math.max(0d, 1000d - segment.normalizedText().length()) / 1000d;
        return new SearchMatch(matchType, quality + tokenScore + positionScore + lengthScore);
    }

    private int boundaryPhrasePosition(String normalizedText, String normalizedQuery) {
        if (normalizedQuery == null || normalizedQuery.isBlank()) {
            return -1;
        }
        String haystack = " " + normalizedText + " ";
        String needle = " " + normalizedQuery + " ";
        int position = haystack.indexOf(needle);
        return position < 0 ? -1 : Math.max(0, position - 1);
    }

    private int countTokenHits(List<String> segmentTokens, List<String> queryTokens, int queryCharacterCount) {
        int hits = 0;
        for (String token : queryTokens) {
            hits += countTokenMatches(segmentTokens, token, queryCharacterCount);
        }
        return hits;
    }

    private int countTokenMatches(List<String> segmentTokens, String token, int queryCharacterCount) {
        if (token.isBlank()) {
            return 0;
        }
        int hits = 0;
        for (String segmentToken : segmentTokens) {
            if (segmentToken.equals(token)) {
                hits++;
                continue;
            }
            if (queryCharacterCount == 3 && token.length() == 3 && segmentToken.startsWith(token)) {
                hits++;
                continue;
            }
            if (queryCharacterCount >= 4 && token.length() >= 3 && segmentToken.startsWith(token)) {
                hits++;
            }
        }
        return hits;
    }

    private TranscriptEvidenceMatch toTranscriptEvidenceMatch(
            Long meetingId,
            String normalizedQuery,
            SearchCandidate candidate,
            List<SearchableTranscriptSegment> segments,
            int context,
            int rank
    ) {
        SearchableTranscriptSegment segment = candidate.segment();
        TruncatedText truncatedText = truncateText(segment.text(), MAX_TRANSCRIPT_SEARCH_MATCH_TEXT_CHARS);
        return new TranscriptEvidenceMatch(
                generatedEvidenceId(meetingId, segment.index(), normalizedQuery),
                segment.segmentId(),
                segment.index(),
                segment.speaker(),
                segment.startTime(),
                segment.endTime(),
                truncatedText.text(),
                truncatedText.truncated(),
                contextSegments(segments, segment.index() - context, segment.index(), MAX_TRANSCRIPT_SEARCH_CONTEXT_TEXT_CHARS),
                contextSegments(segments, segment.index() + 1, segment.index() + context + 1, MAX_TRANSCRIPT_SEARCH_CONTEXT_TEXT_CHARS),
                roundSearchScore(candidate.searchMatch().score()),
                rank,
                candidate.searchMatch().matchType()
        );
    }

    private List<TranscriptEvidenceContext> contextSegments(
            List<SearchableTranscriptSegment> segments,
            int fromInclusive,
            int toExclusive,
            int maxTextChars
    ) {
        int safeFrom = Math.max(0, fromInclusive);
        int safeTo = Math.min(segments.size(), toExclusive);
        if (safeFrom >= safeTo) {
            return List.of();
        }
        List<TranscriptEvidenceContext> contextRows = new ArrayList<>();
        for (int i = safeFrom; i < safeTo; i++) {
            SearchableTranscriptSegment segment = segments.get(i);
            TruncatedText truncatedText = truncateText(segment.text(), maxTextChars);
            contextRows.add(new TranscriptEvidenceContext(
                    segment.segmentId(),
                    segment.index(),
                    segment.speaker(),
                    segment.startTime(),
                    segment.endTime(),
                    truncatedText.text(),
                    truncatedText.truncated()
            ));
        }
        return contextRows;
    }

    private List<String> searchTokens(String normalizedQuery) {
        if (normalizedQuery == null || normalizedQuery.isBlank()) {
            return List.of();
        }
        return List.of(normalizedQuery.split(" "));
    }

    private TruncatedText truncateText(String value, int maxChars) {
        String text = value == null ? "" : value;
        if (text.length() <= maxChars) {
            return new TruncatedText(text, false);
        }
        return new TruncatedText(text.substring(0, maxChars), true);
    }

    private double roundSearchScore(double score) {
        return Math.round(score * 1000d) / 1000d;
    }

    private String generatedEvidenceId(Long meetingId, int index, String normalizedQuery) {
        String querySlug = normalizedQuery.replace(' ', '-');
        if (querySlug.length() > 48) {
            querySlug = querySlug.substring(0, 48);
        }
        return "meeting-" + meetingId + "-segment-" + index + "-" + querySlug;
    }

    private String generatedSegmentId(Long meetingId, int index, double startTime, String speaker) {
        String speakerSlug = normalizeSearchText(speaker).replace(' ', '_');
        if (speakerSlug.isBlank()) {
            speakerSlug = "speaker_" + (index + 1);
        }
        return "meeting-" + meetingId + "-start-" + String.format(Locale.ROOT, "%.3f", startTime) + "-" + speakerSlug;
    }

    private String firstNonBlank(Object... values) {
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

    private double parseTimeSeconds(Object... values) {
        if (values == null) {
            return 0d;
        }
        for (Object value : values) {
            if (value == null) {
                continue;
            }
            try {
                return Double.parseDouble(String.valueOf(value).trim());
            } catch (NumberFormatException ignored) {
                // try next value
            }
        }
        return 0d;
    }

    private double resolveEnd(double startTime, double endTime) {
        return endTime <= 0d || endTime < startTime ? startTime : endTime;
    }

    private String computeHash(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException ex) {
            return Integer.toHexString(value.hashCode());
        }
    }

    private record SearchableTranscriptSegment(
            int index,
            String segmentId,
            String speaker,
            double startTime,
            double endTime,
            String text,
            String normalizedText
    ) {
    }

    private record SearchMatch(String matchType, double score) {
    }

    private record SearchCandidate(SearchableTranscriptSegment segment, SearchMatch searchMatch) {
    }

    private record TruncatedText(String text, boolean truncated) {
    }
}
