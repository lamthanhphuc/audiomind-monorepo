package com.example.processingservice.service;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.Test;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;

class EvidenceQaScorerTest {

  @Test
  void scoreMatchReturnsUnscoredWhenEvidenceQaDisabled() {
    Map<String, Object> canonicalRow = Map.of(
        "segmentId", "seg-1",
        "text", "hop dong",
        "speaker", "SPEAKER_1",
        "startTime", 1.0,
        "endTime", 2.0,
        "termFrequency", Map.of("hop_dong", 1)
    );
    TranscriptQualityContext context = new TranscriptQualityContext(
        "canonical-transcript-v2",
        "hash",
        List.of(canonicalRow),
        Map.of("idf", Map.of("hop_dong", 0.8), "segmentCount", 1)
    );
    ObjectNode policy = new ObjectMapper().createObjectNode();

    EvidenceQaScorer.ScoredEvidence scored = EvidenceQaScorer.scoreMatch(
        7L,
        "hop_dong",
        canonicalRow,
        0,
        context,
        policy,
        false
    );

    assertNull(scored.verificationStatus());
  }

  @Test
  void scoreMatchReturnsVerifiedWhenScoreAboveMin() {
    Map<String, Object> canonicalRow = Map.of(
        "segmentId", "seg-1",
        "text", "hop dong da ky",
        "speaker", "SPEAKER_1",
        "startTime", 1.0,
        "endTime", 2.0,
        "termFrequency", Map.of("hop_dong", 2)
    );
    TranscriptQualityContext context = new TranscriptQualityContext(
        "canonical-transcript-v2",
        "hash",
        List.of(canonicalRow),
        Map.of("idf", Map.of("hop_dong", 1.2), "segmentCount", 1)
    );
    ObjectNode policy = new ObjectMapper().createObjectNode();
    policy.putObject("evidence")
        .put("minScore", 0.35)
        .put("speakerBoost", 1.1)
        .put("positionNormDecay", 0.5);

    EvidenceQaScorer.ScoredEvidence scored = EvidenceQaScorer.scoreMatch(
        7L,
        "hop_dong",
        canonicalRow,
        0,
        context,
        policy.path("evidence"),
        true
    );

    assertEquals("verified", scored.verificationStatus());
  }

  @Test
  void scoreMatchLogsStatsMissingWhenIdfKeyAbsent() {
    Map<String, Object> canonicalRow = Map.of(
        "segmentId", "seg-1",
        "text", "missing term",
        "speaker", "SPEAKER_1",
        "startTime", 1.0,
        "endTime", 2.0,
        "termFrequency", Map.of("other", 1)
    );
    TranscriptQualityContext context = new TranscriptQualityContext(
        "canonical-transcript-v2",
        "hash",
        List.of(canonicalRow),
        Map.of("idf", Map.of("other", 0.5), "segmentCount", 1)
    );
    ObjectNode policy = new ObjectMapper().createObjectNode();
    policy.putObject("evidence").put("minScore", 0.35);

    EvidenceQaScorer.ScoredEvidence scored = EvidenceQaScorer.scoreMatch(
        7L,
        "hop_dong",
        canonicalRow,
        0,
        context,
        policy.path("evidence"),
        true
    );

    assertEquals("unverified", scored.verificationStatus());
  }
}
