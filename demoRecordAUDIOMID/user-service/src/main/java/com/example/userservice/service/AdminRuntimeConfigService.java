package com.example.userservice.service;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
public class AdminRuntimeConfigService {

    private static final List<ConfigDefinition> DEFINITIONS = List.of(
            new ConfigDefinition("DEEPGRAM_API_KEY", "Deepgram API key", "STT", true),
            new ConfigDefinition("DEEPGRAM_MODEL", "Deepgram batch model", "STT", false),
            new ConfigDefinition("DEEPGRAM_REALTIME_MODEL", "Deepgram realtime model", "STT", false),
            new ConfigDefinition("DEEPGRAM_BATCH_MODEL", "Deepgram batch model", "STT", false),
            new ConfigDefinition("DEEPGRAM_LANGUAGE", "Deepgram language", "STT", false),
            new ConfigDefinition("DEEPGRAM_BASE_URL", "Deepgram base URL", "STT", false),
            new ConfigDefinition("DEEPGRAM_SMART_FORMAT", "Deepgram smart format", "STT", false),
            new ConfigDefinition("DEEPGRAM_UTTERANCES", "Deepgram utterances", "STT", false),
            new ConfigDefinition("DEEPGRAM_PARAGRAPHS", "Deepgram paragraphs", "STT", false),
            new ConfigDefinition("DEEPGRAM_DIARIZE", "Deepgram diarize", "STT", false),
            new ConfigDefinition("STT_PROVIDER", "STT provider", "STT", false),
            new ConfigDefinition("GEMINI_API_KEY", "Gemini API key", "AI", true),
            new ConfigDefinition("GEMINI_API_KEYS", "Gemini API keys", "AI", true),
            new ConfigDefinition("GEMINI_API_KEY_BACKUP", "Gemini backup key", "AI", true),
            new ConfigDefinition("GEMINI_MULTI_KEY_ENABLED", "Gemini multi-key", "AI", false),
            new ConfigDefinition("GEMINI_MODEL", "Gemini default model", "AI", false),
            new ConfigDefinition("GEMINI_ANALYSIS_MODEL", "Gemini analysis model", "AI", false),
            new ConfigDefinition("GEMINI_SUMMARY_MODEL", "Gemini summary model", "AI", false),
            new ConfigDefinition("GEMINI_STUDY_ARTIFACT_MAX_OUTPUT_TOKENS", "Study artifact output tokens", "AI", false),
            new ConfigDefinition("GEMINI_STUDY_MIND_MAP_MAX_OUTPUT_TOKENS", "Mindmap output tokens", "AI", false),
            new ConfigDefinition("SUBJECT_SYNTHESIS_MAX_INPUT_TOKENS", "Synthesis input tokens", "AI", false),
            new ConfigDefinition("STUDY_MIND_MAP_MAX_INPUT_TOKENS", "Mindmap input tokens", "AI", false),
            new ConfigDefinition("GEMINI_MAX_TOTAL_ATTEMPTS", "Gemini max total attempts", "AI", false),
            new ConfigDefinition("GEMINI_MAX_ATTEMPTS", "Gemini max attempts", "AI", false),
            new ConfigDefinition("GEMINI_KEY_COOLDOWN_SECONDS", "Gemini key cooldown", "AI", false),
            new ConfigDefinition("GEMINI_TIMEOUT_SECONDS", "Gemini timeout seconds", "AI", false),
            new ConfigDefinition("AI_PROVIDER", "AI provider", "AI", false),
            new ConfigDefinition("ANALYSIS_PROVIDER", "Analysis provider", "AI", false)
    );

    private static final Set<String> ALLOWED_KEYS = DEFINITIONS.stream()
            .map(ConfigDefinition::key)
            .collect(java.util.stream.Collectors.toUnmodifiableSet());

    private static final List<String> BASE_COMPOSE_COMMAND = List.of(
            "docker",
            "compose",
            "--env-file",
            "infra/.env",
            "-f",
            "infra/docker-compose.dev.yml",
            "-f",
            "infra/docker-compose.mvp.yml"
    );

    private final Path workdir;
    private final Path envFile;
    private final long deployTimeoutSeconds;

    public AdminRuntimeConfigService(
            @Value("${admin.runtime-config.workdir:${ADMIN_CONFIG_WORKDIR:.}}") String configuredWorkdir,
            @Value("${admin.runtime-config.env-file:${ADMIN_CONFIG_ENV_FILE:infra/.env}}") String configuredEnvFile,
            @Value("${admin.runtime-config.deploy-timeout-seconds:${ADMIN_DEPLOY_TIMEOUT_SECONDS:1800}}") long deployTimeoutSeconds
    ) {
        this.workdir = Path.of(configuredWorkdir).toAbsolutePath().normalize();
        Path envPath = Path.of(configuredEnvFile);
        this.envFile = envPath.isAbsolute() ? envPath.normalize() : this.workdir.resolve(envPath).normalize();
        this.deployTimeoutSeconds = Math.max(60, deployTimeoutSeconds);
    }

    public RuntimeConfigView readConfig() {
        Map<String, String> values = readEnvValues();
        List<RuntimeConfigItem> items = DEFINITIONS.stream()
                .map(definition -> {
                    String value = values.getOrDefault(definition.key(), "");
                    return new RuntimeConfigItem(
                            definition.key(),
                            definition.label(),
                            definition.group(),
                            definition.secret(),
                            !value.isBlank(),
                            definition.secret() ? mask(value) : value
                    );
                })
                .toList();
        return new RuntimeConfigView(envFile.toString(), workdir.toString(), items);
    }

    public RuntimeConfigUpdateResult updateConfig(Map<String, String> updates, String deployTarget, boolean deploy) {
        if (updates == null || updates.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No config updates provided");
        }
        Map<String, String> normalizedUpdates = new LinkedHashMap<>();
        updates.forEach((rawKey, rawValue) -> {
            String key = normalizeKey(rawKey);
            if (!ALLOWED_KEYS.contains(key)) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Config key is not allowed: " + rawKey);
            }
            if (rawValue != null && !rawValue.isBlank()) {
                normalizedUpdates.put(key, rawValue.trim());
            }
        });
        if (normalizedUpdates.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "No non-empty config updates provided");
        }

        writeEnvValues(normalizedUpdates);
        DeployResult deployResult = deploy ? deploy(deployTarget, inferAffectedServices(normalizedUpdates.keySet())) : null;
        return new RuntimeConfigUpdateResult(
                normalizedUpdates.keySet().stream().sorted().toList(),
                readConfig(),
                deployResult
        );
    }

    public DeployResult deploy(String target, List<String> services) {
        String normalizedTarget = normalizeDeployTarget(target);
        List<String> safeServices = normalizeServices(services);
        List<String> buildCommand = composeCommand(normalizedTarget, "build", safeServices);
        CommandResult build = runCommand(buildCommand);
        if (build.exitCode() != 0) {
            return new DeployResult(normalizedTarget, safeServices, List.of(build), false);
        }
        List<String> upCommand = composeCommand(normalizedTarget, "up", merge(List.of("-d"), safeServices));
        CommandResult up = runCommand(upCommand);
        return new DeployResult(normalizedTarget, safeServices, List.of(build, up), up.exitCode() == 0);
    }

    private Map<String, String> readEnvValues() {
        List<String> lines = readEnvLines();
        Map<String, String> values = new LinkedHashMap<>();
        for (String line : lines) {
            EnvLine parsed = parseEnvLine(line);
            if (parsed != null) {
                values.put(parsed.key(), parsed.value());
            }
        }
        return values;
    }

    private void writeEnvValues(Map<String, String> updates) {
        List<String> lines = readEnvLines();
        Map<String, Integer> indexes = new LinkedHashMap<>();
        for (int i = 0; i < lines.size(); i++) {
            EnvLine parsed = parseEnvLine(lines.get(i));
            if (parsed != null) {
                indexes.put(parsed.key(), i);
            }
        }

        for (Map.Entry<String, String> entry : updates.entrySet()) {
            String rendered = entry.getKey() + "=" + renderEnvValue(entry.getValue());
            Integer index = indexes.get(entry.getKey());
            if (index == null) {
                lines.add(rendered);
            } else {
                lines.set(index, rendered);
            }
        }

        try {
            Files.createDirectories(envFile.getParent());
            if (Files.exists(envFile)) {
                Path backup = envFile.resolveSibling(envFile.getFileName() + ".bak-" + Instant.now().toEpochMilli());
                Files.copy(envFile, backup, StandardCopyOption.REPLACE_EXISTING);
            }
            Files.write(envFile, lines, StandardCharsets.UTF_8);
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not write env file", ex);
        }
    }

    private List<String> readEnvLines() {
        if (!Files.exists(envFile)) {
            return new ArrayList<>();
        }
        try {
            return new ArrayList<>(Files.readAllLines(envFile, StandardCharsets.UTF_8));
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.INTERNAL_SERVER_ERROR, "Could not read env file", ex);
        }
    }

    private CommandResult runCommand(List<String> command) {
        ProcessBuilder builder = new ProcessBuilder(command);
        builder.directory(workdir.toFile());
        builder.redirectErrorStream(true);
        StringBuilder output = new StringBuilder();
        try {
            Process process = builder.start();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    output.append(line).append('\n');
                    if (output.length() > 12000) {
                        output.delete(0, output.length() - 12000);
                    }
                }
            }
            boolean completed = process.waitFor(deployTimeoutSeconds, TimeUnit.SECONDS);
            if (!completed) {
                process.destroyForcibly();
                return new CommandResult(command, 124, "Command timed out after " + deployTimeoutSeconds + "s");
            }
            return new CommandResult(command, process.exitValue(), output.toString());
        } catch (IOException ex) {
            return new CommandResult(command, 127, ex.getMessage());
        } catch (InterruptedException ex) {
            Thread.currentThread().interrupt();
            return new CommandResult(command, 130, "Command interrupted");
        }
    }

    private static EnvLine parseEnvLine(String line) {
        String trimmed = line.trim();
        if (trimmed.isBlank() || trimmed.startsWith("#") || !trimmed.contains("=")) {
            return null;
        }
        int separator = line.indexOf('=');
        String key = line.substring(0, separator).trim();
        if (key.isBlank()) {
            return null;
        }
        return new EnvLine(key, line.substring(separator + 1).trim());
    }

    private static String renderEnvValue(String value) {
        if (value.contains("\n") || value.contains("\r")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Config value must be one line");
        }
        if (value.contains(" ") || value.contains("#") || value.contains("\"")) {
            return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\"";
        }
        return value;
    }

    private static String normalizeKey(String key) {
        return key == null ? "" : key.trim().toUpperCase(Locale.ROOT);
    }

    private static String normalizeDeployTarget(String target) {
        String normalized = target == null || target.isBlank() ? "local" : target.trim().toLowerCase(Locale.ROOT);
        if (!"local".equals(normalized) && !"vps".equals(normalized)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Invalid deploy target");
        }
        return normalized;
    }

    private static List<String> normalizeServices(List<String> services) {
        Set<String> safe = new LinkedHashSet<>();
        if (services != null) {
            for (String service : services) {
                String normalized = service == null ? "" : service.trim();
                if (Set.of("ai-api", "celery-worker", "web", "user-api", "meeting-api", "processing-api").contains(normalized)) {
                    safe.add(normalized);
                }
            }
        }
        if (safe.isEmpty()) {
            safe.add("ai-api");
            safe.add("celery-worker");
        }
        return safe.stream().sorted(Comparator.naturalOrder()).toList();
    }

    private static List<String> inferAffectedServices(Set<String> keys) {
        Set<String> services = new LinkedHashSet<>();
        for (String key : keys) {
            if (key.startsWith("DEEPGRAM_")
                    || key.startsWith("GEMINI_")
                    || key.startsWith("STT_")
                    || "AI_PROVIDER".equals(key)
                    || "ANALYSIS_PROVIDER".equals(key)) {
                services.add("ai-api");
                services.add("celery-worker");
            }
        }
        return services.stream().toList();
    }

    private static List<String> composeCommand(String target, String action, List<String> tail) {
        List<String> command = new ArrayList<>(BASE_COMPOSE_COMMAND);
        if ("vps".equals(target)) {
            command.add("-f");
            command.add("infra/docker-compose.prod.yml");
        }
        command.add(action);
        command.addAll(tail);
        return command;
    }

    private static List<String> merge(List<String> first, List<String> second) {
        List<String> merged = new ArrayList<>(first);
        merged.addAll(second);
        return merged;
    }

    private static String mask(String value) {
        if (value == null || value.isBlank()) {
            return "";
        }
        String unquoted = value.replaceAll("^\"|\"$", "");
        if (unquoted.length() <= 8) {
            return "********";
        }
        return unquoted.substring(0, 4) + "..." + unquoted.substring(unquoted.length() - 4);
    }

    private record EnvLine(String key, String value) {
    }

    public record ConfigDefinition(String key, String label, String group, boolean secret) {
    }

    public record RuntimeConfigItem(
            String key,
            String label,
            String group,
            boolean secret,
            boolean configured,
            String value
    ) {
    }

    public record RuntimeConfigView(String envFile, String workdir, List<RuntimeConfigItem> items) {
    }

    public record RuntimeConfigUpdateResult(
            List<String> updatedKeys,
            RuntimeConfigView config,
            DeployResult deploy
    ) {
    }

    public record DeployResult(
            String target,
            List<String> services,
            List<CommandResult> commands,
            boolean success
    ) {
    }

    public record CommandResult(List<String> command, int exitCode, String output) {
    }
}
