package com.example.userservice.teams;

import com.example.userservice.client.MeetingClient;
import com.example.userservice.client.ProcessingClient;
import com.example.userservice.controller.dto.TeamsImportRecordingResponse;
import com.example.userservice.controller.dto.TeamsRecordingsResponse;
import com.example.userservice.controller.dto.TeamsStatusResponse;
import com.example.userservice.entity.TeamsOAuthGrant;
import com.example.userservice.repository.TeamsOAuthGrantRepository;
import com.example.userservice.repository.UserAccountRepository;
import java.net.URI;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;
import org.springframework.web.util.UriComponentsBuilder;

@Service
public class TeamsGrantService {

    private static final Logger log = LoggerFactory.getLogger(TeamsGrantService.class);
    private static final Duration MAX_ACCESS_TOKEN_TTL = Duration.ofSeconds(3500);

    private final TeamsOAuthProperties properties;
    private final TeamsOAuthRedisStore redisStore;
    private final TeamsOAuthClient oauthClient;
    private final TeamsTokenCipher tokenCipher;
    private final TeamsOAuthGrantRepository grantRepository;
    private final UserAccountRepository userRepository;
    private final MeetingClient meetingClient;
    private final ProcessingClient processingClient;
    private final SecureRandom secureRandom = new SecureRandom();

    public TeamsGrantService(
            TeamsOAuthProperties properties,
            TeamsOAuthRedisStore redisStore,
            TeamsOAuthClient oauthClient,
            TeamsTokenCipher tokenCipher,
            TeamsOAuthGrantRepository grantRepository,
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
                .orElseThrow(() -> new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_NOT_CONFIGURED));
        String state = randomToken(32);
        redisStore.saveLinkState(state, userId, validateRedirectAfter(redirectAfter));
        log.info("event=TEAMS_LINK_STARTED traceId={} userId={}", MDC.get("traceId"), userId);
        return oauthClient.buildAuthorizeUri(state);
    }

    public URI handleLinkCallback(String code, String state, String providerError) {
        properties.requireGrantConfigured();
        try {
            TeamsOAuthRedisStore.TeamsLinkState linkState = redisStore.consumeLinkState(state);
            if (providerError != null && !providerError.isBlank()) {
                return errorRedirect("provider_error");
            }
            if (code == null || code.isBlank()) {
                return errorRedirect("missing_code");
            }
            TeamsTokenResponse tokens = oauthClient.exchangeCode(code);
            if (tokens.refreshToken() == null || tokens.refreshToken().isBlank()) {
                throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR);
            }
            TeamsUserProfile profile = oauthClient.fetchCurrentUser(tokens.accessToken());
            link(linkState.userId(), profile, tokens);
            return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                    .queryParam("teams", "linked")
                    .queryParam("redirectAfter", linkState.redirectAfter())
                    .build().encode().toUri();
        } catch (TeamsOAuthException ex) {
            log.warn("event=TEAMS_LINK_CALLBACK_FAILED traceId={} errorCode={}",
                    MDC.get("traceId"), ex.error().name());
            return errorRedirect(ex.error().name().toLowerCase(Locale.ROOT));
        }
    }

    @Transactional
    public void link(Long userId, TeamsUserProfile profile, TeamsTokenResponse tokens) {
        if (profile == null || profile.id() == null || profile.id().isBlank()) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR);
        }
        grantRepository.findByTeamsUserIdAndRevokedAtIsNull(profile.id())
                .filter(grant -> !grant.getUserId().equals(userId))
                .ifPresent(grant -> {
                    throw new TeamsOAuthException(TeamsOAuthError.TEAMS_ACCOUNT_ALREADY_LINKED);
                });
        TeamsTokenCipher.EncryptedToken encrypted = tokenCipher.encrypt(tokens.refreshToken());
        Instant now = Instant.now();
        TeamsOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId).orElseGet(TeamsOAuthGrant::new);
        grant.setUserId(userId);
        grant.setTeamsUserId(profile.id());
        grant.setTeamsEmail(profile.email());
        grant.setEncryptedRefreshToken(encrypted.ciphertext());
        grant.setTokenIv(encrypted.iv());
        grant.setTokenKid(encrypted.kid());
        grant.setGrantedScopes(new ArrayList<>(TeamsScopes.LINK));
        if (grant.getCreatedAt() == null) {
            grant.setCreatedAt(now);
        }
        grant.setUpdatedAt(now);
        grant.setRevokedAt(null);
        grantRepository.save(grant);
        cacheAccessToken(userId, tokens);
    }

    public TeamsStatusResponse status(Long userId) {
        return grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .map(grant -> new TeamsStatusResponse(
                        true,
                        grant.getTeamsEmail(),
                        grant.getGrantedScopes() == null ? List.of() : grant.getGrantedScopes()))
                .orElseGet(() -> new TeamsStatusResponse(false, null, List.of()));
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

    public TeamsRecordingsResponse listRecordings(Long userId, LocalDate from, LocalDate to) {
        LocalDate effectiveTo = to == null ? LocalDate.now() : to;
        LocalDate effectiveFrom = from == null ? effectiveTo.minusDays(30) : from;
        String accessToken = accessToken(userId);
        List<Map<String, Object>> meetings = oauthClient.listRecordings(accessToken, effectiveFrom, effectiveTo);
        return new TeamsRecordingsResponse(effectiveFrom.toString(), effectiveTo.toString(), meetings);
    }

    public TeamsImportRecordingResponse importRecording(
            Long userId,
            String authorization,
            String meetingUuid,
            String recordingFileId,
            String title,
            String language
    ) {
        if (!StringUtils.hasText(authorization)) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_NOT_CONFIGURED);
        }
        if (!StringUtils.hasText(meetingUuid)) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_RECORDING_NOT_FOUND);
        }
        String[] parts = meetingUuid.split(":", 2);
        String onlineMeetingId = parts[0];
        String recordingId = parts.length > 1 ? parts[1] : recordingFileId;
        if (!StringUtils.hasText(recordingId)) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_RECORDING_NOT_FOUND);
        }
        String accessToken = accessToken(userId);
        byte[] bytes = oauthClient.downloadRecording(accessToken, onlineMeetingId, recordingId);
        String filename = "teams-" + sanitizeFilename(onlineMeetingId) + ".mp4";
        String resolvedTitle = StringUtils.hasText(title) ? title.trim() : "Teams recording";
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
        return new TeamsImportRecordingResponse(
                meetingId,
                duplicate,
                reused,
                processingStarted,
                resolvedTitle,
                status
        );
    }

    private String accessToken(Long userId) {
        TeamsOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .orElseThrow(() -> new TeamsOAuthException(TeamsOAuthError.TEAMS_REFRESH_TOKEN_REVOKED));
        String cached = redisStore.getAccessToken(userId);
        if (StringUtils.hasText(cached)) {
            return cached;
        }
        String refreshToken = tokenCipher.decrypt(
                grant.getEncryptedRefreshToken(),
                grant.getTokenIv(),
                grant.getTokenKid());
        TeamsTokenResponse refreshed = oauthClient.refreshAccessToken(refreshToken);
        cacheAccessToken(userId, refreshed);
        return refreshed.accessToken();
    }

    private void cacheAccessToken(Long userId, TeamsTokenResponse tokens) {
        if (tokens.accessToken() == null || tokens.accessToken().isBlank()) {
            throw new TeamsOAuthException(TeamsOAuthError.TEAMS_OAUTH_PROVIDER_ERROR);
        }
        long expiresIn = tokens.expiresIn() == null ? 3600L : tokens.expiresIn();
        Duration ttl = Duration.ofSeconds(Math.min(expiresIn - 60, MAX_ACCESS_TOKEN_TTL.toSeconds()));
        redisStore.saveAccessToken(userId, tokens.accessToken(), ttl);
    }

    private URI errorRedirect(String reason) {
        return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                .queryParam("teams", "error")
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
