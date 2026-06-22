package com.example.meetingservice.config;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.io.InputStream;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

@Component
public class UploadValidationPolicy {

    private static final long DEFAULT_MAX_UPLOAD_BYTES = 104_857_600L;
    private static final Set<String> DEFAULT_EXTENSIONS = Set.of(".mp3", ".wav", ".m4a");

    private final long maxUploadBytes;
    private final Set<String> allowedExtensions;
    private final List<String> allowedMimeTypes;

    public UploadValidationPolicy(ObjectMapper objectMapper) {
        JsonNode root = loadPolicy(objectMapper);
        this.maxUploadBytes = root.path("maxUploadBytes").asLong(DEFAULT_MAX_UPLOAD_BYTES);
        this.allowedExtensions = readExtensions(root);
        this.allowedMimeTypes = readMimeTypes(root);
    }

    public long maxUploadBytes() {
        return maxUploadBytes;
    }

    public Set<String> allowedExtensions() {
        return allowedExtensions;
    }

    public List<String> allowedMimeTypes() {
        return allowedMimeTypes;
    }

    private static JsonNode loadPolicy(ObjectMapper objectMapper) {
        try (InputStream input = new ClassPathResource("upload-validation-policy.json").getInputStream()) {
            return objectMapper.readTree(input);
        } catch (IOException ex) {
            return objectMapper.createObjectNode()
                    .put("maxUploadBytes", DEFAULT_MAX_UPLOAD_BYTES)
                    .set("allowedExtensions", objectMapper.valueToTree(DEFAULT_EXTENSIONS));
        }
    }

    private static Set<String> readExtensions(JsonNode root) {
        Set<String> extensions = new LinkedHashSet<>();
        for (JsonNode node : root.path("allowedExtensions")) {
            String value = node.asText("").trim().toLowerCase();
            if (!value.isBlank()) {
                extensions.add(value.startsWith(".") ? value : "." + value);
            }
        }
        return extensions.isEmpty() ? DEFAULT_EXTENSIONS : Set.copyOf(extensions);
    }

    private static List<String> readMimeTypes(JsonNode root) {
        java.util.ArrayList<String> mimeTypes = new java.util.ArrayList<>();
        for (JsonNode node : root.path("allowedMimeTypes")) {
            String value = node.asText("").trim();
            if (!value.isBlank()) {
                mimeTypes.add(value);
            }
        }
        return List.copyOf(mimeTypes);
    }
}
