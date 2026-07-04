package com.example.processingservice.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

@Component
public class Epic3PolicyLoader {

    public static final String SERVICE_NAME = "processing-service";
    public static final String PRIMARY_POLICY_RESOURCE = "transcript-quality-policy.json";
    public static final String FALLBACK_POLICY_RESOURCE = "default-policy.json";

    private static final Logger log = LoggerFactory.getLogger(Epic3PolicyLoader.class);

    private final ObjectMapper objectMapper;
    private final JsonNode policyRoot;

    @Autowired
    public Epic3PolicyLoader(ObjectMapper objectMapper) {
        this(objectMapper, PRIMARY_POLICY_RESOURCE, FALLBACK_POLICY_RESOURCE);
    }

    Epic3PolicyLoader(ObjectMapper objectMapper, String primaryResource, String fallbackResource) {
        this.objectMapper = objectMapper;
        this.policyRoot = loadPolicy(primaryResource, fallbackResource);
    }

    public JsonNode getPolicy() {
        return policyRoot;
    }

    @SuppressWarnings("unchecked")
    public Map<String, Object> asMap() {
        return objectMapper.convertValue(policyRoot, LinkedHashMap.class);
    }

    private JsonNode loadPolicy(String primaryResource, String fallbackResource) {
        Optional<JsonNode> primary = readClasspathPolicy(primaryResource);
        if (primary.isPresent()) {
            return primary.get();
        }

        logPolicyLoadFallback(primaryResource, resolveFailureReason(primaryResource), fallbackResource);
        Optional<JsonNode> fallback = readClasspathPolicy(fallbackResource);
        if (fallback.isPresent()) {
            return fallback.get();
        }

        logPolicyLoadFallback(fallbackResource, resolveFailureReason(fallbackResource), "hardcoded");
        return hardcodedDefaults();
    }

    private Optional<JsonNode> readClasspathPolicy(String resourcePath) {
        ClassPathResource resource = new ClassPathResource(resourcePath);
        if (!resource.exists()) {
            return Optional.empty();
        }
        try (InputStream input = resource.getInputStream()) {
            JsonNode node = objectMapper.readTree(input);
            if (!TranscriptQualityPolicyValidator.isValid(node)) {
                return Optional.empty();
            }
            return Optional.of(node);
        } catch (IOException ex) {
            return Optional.empty();
        }
    }

    private String resolveFailureReason(String resourcePath) {
        ClassPathResource resource = new ClassPathResource(resourcePath);
        if (!resource.exists()) {
            return "missing";
        }
        try (InputStream input = resource.getInputStream()) {
            JsonNode node = objectMapper.readTree(input);
            if (!TranscriptQualityPolicyValidator.isValid(node)) {
                return "schema_invalid";
            }
            return "parse_error";
        } catch (IOException ex) {
            return "parse_error";
        }
    }

    private void logPolicyLoadFallback(String path, String reason, String fallbackPath) {
        log.warn(
                "event=POLICY_LOAD_FALLBACK path={} reason={} service={} fallbackPath={}",
                path,
                reason,
                SERVICE_NAME,
                fallbackPath
        );
    }

    private ObjectNode hardcodedDefaults() {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("version", "1.0.0");

        ObjectNode transcript = root.putObject("transcript");
        transcript.put("canonicalVersion", "canonical-transcript-v2");
        transcript.put("shortSegmentMaxWords", 3);
        transcript.put("mergeMaxGapSeconds", 5);
        transcript.put("displayGroupingEnabled", true);

        ObjectNode search = root.putObject("search");
        search.put("minQueryLength", 2);
        search.put("minTokenLength", 2);
        search.put("maxLimit", 50);
        search.put("maxContext", 3);
        search.put("phraseMinLength", 4);
        search.put("maxScanSegments", 2000);
        search.put("scanPreference", "recent");

        ObjectNode evidence = root.putObject("evidence");
        evidence.put("minScore", 0.35);
        evidence.put("dedupeWindowSeconds", 2.0);
        evidence.put("maxMatchesPerActionItem", 1);
        evidence.put("speakerBoost", 1.1);
        evidence.put("positionNormDecay", 0.5);

        ObjectNode export = root.putObject("export");
        export.putArray("supportedFormats").add("txt").add("csv").add("docx");
        export.put("defaultTranscriptMode", "readable");
        export.put("includeEvidenceNotes", true);

        ObjectNode lexicon = root.putObject("lexicon");
        lexicon.put("defaultDomainPack", "general");
        lexicon
                .putArray("supportedDomainPacks")
                .add("general")
                .add("legal")
                .add("finance")
                .add("healthcare")
                .add("it")
                .add("business")
                .add("education");
        lexicon.putArray("disabledTerms");

        return root;
    }
}
