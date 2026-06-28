package com.example.userservice.zoom;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.client.ProcessingClient;
import com.example.userservice.controller.dto.ZoomImportRecordingResponse;
import com.example.userservice.controller.dto.ZoomRecordingsResponse;
import com.example.userservice.controller.dto.ZoomStatusResponse;
import com.example.userservice.entity.ZoomOAuthGrant;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.ZoomOAuthGrantRepository;
import java.net.URI;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import org.springframework.web.util.UriComponentsBuilder;

@Service
public class ZoomGrantService {

    private static final Logger log = LoggerFactory.getLogger(ZoomGrantService.class);
    private static final Duration MAX_ACCESS_TOKEN_TTL = Duration.ofSeconds(3500);
    private static final Set<String> PREFERRED_AUDIO_TYPES = Set.of("M4A", "MP4", "MP3", "WAV");

    private final ZoomOAuthProperties properties;
    private final ZoomOAuthRedisStore redisStore;
    private final ZoomOAuthClient oauthClient;
    private final ZoomTokenCipher tokenCipher;
    private final ZoomOAuthGrantRepository grantRepository;
    private final UserAccountRepository userRepository;
    private final MeetingClient meetingClient;
    private final ProcessingClient processingClient;
    private final SecureRandom secureRandom = new SecureRandom();

    public ZoomGrantService(
            ZoomOAuthProperties properties,
            ZoomOAuthRedisStore redisStore,
            ZoomOAuthClient oauthClient,
            ZoomTokenCipher tokenCipher,
            ZoomOAuthGrantRepository grantRepository,
            UserAccountRepository userRepository,
            MeetingClient meetingClient,
            ProcessingClient processingClient) {
        this.properties = properties;
        this.redisStore = redisStore;
        this.oauthClient = oauthClient;
        this.tokenCipher = tokenCipher;
        this.grantRepository = grantRepository;
        this.userRepository = userRepository;
        this.meetingClient = meetingClient;
        this.processingClient = processingClient;
    }

    public URI startLink(Long userId, String redirectAfter) {
        properties.requireGrantConfigured();
        userRepository.findById(userId)
                .orElseThrow(() -> new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_NOT_CONFIGURED));
        String state = randomToken(32);
        redisStore.saveLinkState(state, userId, validateRedirectAfter(redirectAfter));
        log.info("event=ZOOM_LINK_STARTED traceId={} userId={}", MDC.get("traceId"), userId);
        return UriComponentsBuilder.fromUriString("https://zoom.us/oauth/authorize")
                .queryParam("response_type", "code")
                .queryParam("client_id", properties.getClientId())
                .queryParam("redirect_uri", properties.getRedirectUri())
                .queryParam("state", state)
                .queryParam("scope", String.join(" ", ZoomScopes.LINK))
                .build().encode().toUri();
    }

    public URI handleLinkCallback(String code, String state, String providerError) {
        properties.requireGrantConfigured();
        try {
            ZoomOAuthRedisStore.ZoomLinkState linkState = redisStore.consumeLinkState(state);
            if (providerError != null && !providerError.isBlank()) {
                return errorRedirect("provider_error");
            }
            if (code == null || code.isBlank()) {
                return errorRedirect("missing_code");
            }
            ZoomTokenResponse tokens = oauthClient.exchangeCode(code);
            if (tokens.refreshToken() == null || tokens.refreshToken().isBlank()) {
                throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR);
            }
            ZoomUserProfile profile = oauthClient.fetchCurrentUser(tokens.accessToken());
            link(linkState.userId(), profile, tokens);
            return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                    .queryParam("zoom", "linked")
                    .queryParam("redirectAfter", linkState.redirectAfter())
                    .build().encode().toUri();
        } catch (ZoomOAuthException ex) {
            log.warn("event=ZOOM_LINK_CALLBACK_FAILED traceId={} errorCode={}",
                    MDC.get("traceId"), ex.error().name());
            return errorRedirect(ex.error().name().toLowerCase(Locale.ROOT));
        }
    }

    @Transactional
    public void link(Long userId, ZoomUserProfile profile, ZoomTokenResponse tokens) {
        if (profile == null || profile.id() == null || profile.id().isBlank()) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR);
        }
        grantRepository.findByZoomUserIdAndRevokedAtIsNull(profile.id())
                .filter(grant -> !grant.getUserId().equals(userId))
                .ifPresent(grant -> {
                    throw new ZoomOAuthException(ZoomOAuthError.ZOOM_ACCOUNT_ALREADY_LINKED);
                });
        ZoomTokenCipher.EncryptedToken encrypted = tokenCipher.encrypt(tokens.refreshToken());
        Instant now = Instant.now();
        ZoomOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId).orElseGet(ZoomOAuthGrant::new);
        grant.setUserId(userId);
        grant.setZoomUserId(profile.id());
        grant.setZoomEmail(profile.email());
        grant.setEncryptedRefreshToken(encrypted.ciphertext());
        grant.setTokenIv(encrypted.iv());
        grant.setTokenKid(encrypted.kid());
        grant.setGrantedScopes(new ArrayList<>(ZoomScopes.LINK));
        if (grant.getCreatedAt() == null) {
            grant.setCreatedAt(now);
        }
        grant.setUpdatedAt(now);
        grant.setRevokedAt(null);
        grantRepository.save(grant);
        cacheAccessToken(userId, tokens);
    }

    public ZoomStatusResponse status(Long userId) {
        return grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .map(grant -> new ZoomStatusResponse(
                        true,
                        grant.getZoomEmail(),
                        grant.getGrantedScopes() == null ? List.of() : grant.getGrantedScopes()))
                .orElseGet(() -> new ZoomStatusResponse(false, null, List.of()));
    }

    @Transactional
    public void revokeGrant(Long userId) {
        grantRepository.findByUserIdAndRevokedAtIsNull(userId).ifPresent(grant -> {
            grant.setRevokedAt(Instant.now());
            grant.setUpdatedAt(Instant.now());
            grantRepository.save(grant);
            redisStore.clearAccessToken(userId);
        });
    }

    public ZoomRecordingsResponse listRecordings(Long userId, LocalDate from, LocalDate to) {
        LocalDate effectiveTo = to == null ? LocalDate.now() : to;
        LocalDate effectiveFrom = from == null ? effectiveTo.minusDays(30) : from;
        String accessToken = accessToken(userId);
        List<Map<String, Object>> meetings = oauthClient.listRecordings(accessToken, effectiveFrom, effectiveTo);
        return new ZoomRecordingsResponse(effectiveFrom.toString(), effectiveTo.toString(), meetings);
    }

    public ZoomImportRecordingResponse importRecording(
            Long userId,
            String authorization,
            String meetingUuid,
            String recordingFileId,
            String title,
            String language
    ) {
        if (!StringUtils.hasText(authorization)) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_NOT_CONFIGURED);
        }
        if (!StringUtils.hasText(meetingUuid)) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_NOT_FOUND);
        }
        String accessToken = accessToken(userId);
        LocalDate to = LocalDate.now();
        LocalDate from = to.minusDays(90);
        List<Map<String, Object>> meetings = oauthClient.listRecordings(accessToken, from, to);
        Map<String, Object> selectedMeeting = meetings.stream()
                .filter(item -> meetingUuid.equals(String.valueOf(item.get("uuid"))))
                .findFirst()
                .orElseThrow(() -> new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_NOT_FOUND));
        Map<String, Object> selectedFile = selectRecordingFile(selectedMeeting, recordingFileId);
        String downloadUrl = String.valueOf(selectedFile.get("downloadUrl"));
        byte[] bytes = oauthClient.downloadRecording(accessToken, downloadUrl);
        String fileType = String.valueOf(selectedFile.getOrDefault("fileType", "M4A"));
        String filename = "zoom-" + sanitizeFilename(meetingUuid) + "." + fileType.toLowerCase(Locale.ROOT);
        String resolvedTitle = StringUtils.hasText(title)
                ? title.trim()
                : String.valueOf(selectedMeeting.getOrDefault("topic", "Zoom recording"));
        String resolvedLanguage = StringUtils.hasText(language) ? language.trim() : "vi";
        Map<String, Object> upload = meetingClient.uploadMeeting(
                resolvedTitle,
                bytes,
                filename,
                resolvedLanguage,
                authorization
        );
        Long meetingId = longValue(upload.get("id"), upload.get("existingMeetingId"));
        boolean duplicate = Boolean.TRUE.equals(upload.get("duplicate"));
        boolean reused = Boolean.TRUE.equals(upload.get("reused"));
        String status = stringValue(upload.get("status"));
        boolean processingStarted = false;
        if (meetingId != null && !duplicate) {
            processingClient.startProcessing(meetingId, resolvedLanguage, authorization);
            processingStarted = true;
        } else if (meetingId != null && duplicate && !reused && !"completed".equalsIgnoreCase(status)) {
            processingClient.startProcessing(meetingId, resolvedLanguage, authorization);
            processingStarted = true;
        }
        return new ZoomImportRecordingResponse(
                meetingId,
                duplicate,
                reused,
                processingStarted,
                resolvedTitle,
                status
        );
    }

    private Map<String, Object> selectRecordingFile(Map<String, Object> meeting, String recordingFileId) {
        Object rawFiles = meeting.get("recordingFiles");
        if (!(rawFiles instanceof List<?> files) || files.isEmpty()) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_NOT_FOUND);
        }
        List<Map<String, Object>> castFiles = new ArrayList<>();
        for (Object file : files) {
            if (file instanceof Map<?, ?> map) {
                @SuppressWarnings("unchecked")
                Map<String, Object> cast = (Map<String, Object>) map;
                castFiles.add(cast);
            }
        }
        if (StringUtils.hasText(recordingFileId)) {
            return castFiles.stream()
                    .filter(file -> recordingFileId.equals(String.valueOf(file.get("id"))))
                    .findFirst()
                    .orElseThrow(() -> new ZoomOAuthException(ZoomOAuthError.ZOOM_RECORDING_NOT_FOUND));
        }
        return castFiles.stream()
                .filter(this::isPreferredAudioFile)
                .findFirst()
                .orElse(castFiles.get(0));
    }

    private boolean isPreferredAudioFile(Map<String, Object> file) {
        String type = String.valueOf(file.getOrDefault("fileType", "")).toUpperCase(Locale.ROOT);
        return PREFERRED_AUDIO_TYPES.contains(type);
    }

    private String accessToken(Long userId) {
        ZoomOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .orElseThrow(() -> new ZoomOAuthException(ZoomOAuthError.ZOOM_REFRESH_TOKEN_REVOKED));
        String cached = redisStore.getAccessToken(userId);
        if (StringUtils.hasText(cached)) {
            return cached;
        }
        String refreshToken = tokenCipher.decrypt(
                grant.getEncryptedRefreshToken(),
                grant.getTokenIv(),
                grant.getTokenKid());
        ZoomTokenResponse refreshed = oauthClient.refreshAccessToken(refreshToken);
        cacheAccessToken(userId, refreshed);
        return refreshed.accessToken();
    }

    private void cacheAccessToken(Long userId, ZoomTokenResponse tokens) {
        if (tokens.accessToken() == null || tokens.accessToken().isBlank()) {
            throw new ZoomOAuthException(ZoomOAuthError.ZOOM_OAUTH_PROVIDER_ERROR);
        }
        long expiresIn = tokens.expiresIn() == null ? 3600L : tokens.expiresIn();
        Duration ttl = Duration.ofSeconds(Math.min(expiresIn - 60, MAX_ACCESS_TOKEN_TTL.toSeconds()));
        redisStore.saveAccessToken(userId, tokens.accessToken(), ttl);
    }

    private URI errorRedirect(String reason) {
        return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                .queryParam("zoom", "error")
                .queryParam("reason", reason)
                .build().encode().toUri();
    }

    private String validateRedirectAfter(String redirectAfter) {
        if (!StringUtils.hasText(redirectAfter)) {
            return "/upload";
        }
        for (String origin : properties.getAllowedRedirectOrigins()) {
            if (redirectAfter.startsWith(origin)) {
                return redirectAfter;
            }
        }
        if (redirectAfter.startsWith("/")) {
            return redirectAfter;
        }
        return "/upload";
    }

    private String randomToken(int bytes) {
        byte[] buffer = new byte[bytes];
        secureRandom.nextBytes(buffer);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(buffer);
    }

    private static String sanitizeFilename(String value) {
        return value.replaceAll("[^a-zA-Z0-9._-]", "_");
    }

    private static Long longValue(Object... values) {
        for (Object value : values) {
            if (value == null) {
                continue;
            }
            if (value instanceof Number number) {
                return number.longValue();
            }
            try {
                return Long.parseLong(String.valueOf(value));
            } catch (NumberFormatException ignored) {
                // continue
            }
        }
        return null;
    }

    private static String stringValue(Object value) {
        return value == null ? null : String.valueOf(value);
    }
}
