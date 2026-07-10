package com.example.userservice.google;

import com.example.userservice.controller.dto.GoogleStatusResponse;
import com.example.userservice.controller.dto.InternalGoogleAccessTokenResponse;
import com.example.userservice.entity.GoogleOAuthGrant;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.repository.GoogleOAuthGrantRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import java.net.URI;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.util.UriComponentsBuilder;

@Service
public class GoogleGrantService {

    private static final Logger log = LoggerFactory.getLogger(GoogleGrantService.class);
    private static final Duration MAX_ACCESS_TOKEN_TTL = Duration.ofSeconds(3500);

    private final GoogleOAuthProperties properties;
    private final GoogleOAuthRedisStore redisStore;
    private final GoogleOAuthClient oauthClient;
    private final GoogleTokenCipher tokenCipher;
    private final GoogleOAuthGrantRepository grantRepository;
    private final UserAccountRepository userRepository;
    private final UserIdentityRepository identityRepository;
    private final SecureRandom secureRandom = new SecureRandom();

    public GoogleGrantService(
            GoogleOAuthProperties properties,
            GoogleOAuthRedisStore redisStore,
            GoogleOAuthClient oauthClient,
            GoogleTokenCipher tokenCipher,
            GoogleOAuthGrantRepository grantRepository,
            UserAccountRepository userRepository,
            UserIdentityRepository identityRepository) {
        this.properties = properties;
        this.redisStore = redisStore;
        this.oauthClient = oauthClient;
        this.tokenCipher = tokenCipher;
        this.grantRepository = grantRepository;
        this.userRepository = userRepository;
        this.identityRepository = identityRepository;
    }

    public URI startLink(Long userId, Collection<String> additionalScopes, String redirectAfter) {
        properties.requireGrantConfigured();
        userRepository.findById(userId)
                .orElseThrow(() -> new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN));
        List<String> requestedScopes = validateScopes(additionalScopes);
        String state = randomToken(32);
        String nonce = randomToken(32);
        redisStore.saveLinkState(state, nonce, userId, requestedScopes, validateRedirectAfter(redirectAfter));

        List<String> scopes = new ArrayList<>(GoogleScopes.IDENTITY);
        scopes.addAll(requestedScopes);
        log.info("event=GOOGLE_LINK_STARTED traceId={} userId={} scopeCount={}",
                MDC.get("traceId"), userId, scopes.size());
        Optional<String> loginHint = identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(userId, "google")
                .map(UserIdentity::getProviderEmail)
                .filter(email -> email != null && !email.isBlank());
        return GoogleOAuthAuthorizationUrls.buildIntegrationAuthorization(
                properties,
                requestedScopes,
                state,
                nonce,
                loginHint);
    }

    public URI handleLinkCallback(String code, String state, String providerError) {
        properties.requireGrantConfigured();
        try {
            GoogleLoginState linkState = redisStore.consumeLinkState(state);
            if (providerError != null || code == null || code.isBlank()) {
                return errorRedirect(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
            }
            GoogleTokenResponse tokens = oauthClient.exchangeCode(code, properties.getLinkRedirectUri());
            GoogleIdentity googleIdentity = resolveLinkIdentity(tokens, linkState.nonce());
            link(linkState.userId(), googleIdentity, tokens, linkState.requestedScopes());
            return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                    .path("/settings/integrations/google/success")
                    .queryParam("redirectAfter", linkState.redirectAfter())
                    .build().encode().toUri();
        } catch (GoogleOAuthException ex) {
            String cause = ex.getCause() == null ? "none" : ex.getCause().getClass().getSimpleName();
            log.warn("event=GOOGLE_LINK_CALLBACK_FAILED traceId={} errorCode={} cause={} detail={}",
                    MDC.get("traceId"), ex.error().name(), cause, ex.details());
            return errorRedirect(ex.error());
        }
    }

    @Transactional
    public void persistLoginGrant(Long userId, GoogleIdentity googleIdentity, GoogleTokenResponse tokens) {
        properties.requireGrantConfigured();
        UserAccount user = userRepository.findById(userId)
                .orElseThrow(() -> new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN));
        upsertIdentity(user, googleIdentity);
        upsertGrant(userId, googleIdentity.subject(), tokens, List.of());
        redisStore.clearAccessTokens(userId);
        log.info("event=GOOGLE_LOGIN_GRANT_PERSISTED traceId={} userId={} hasRefresh={}",
                MDC.get("traceId"), userId,
                tokens.refreshToken() != null && !tokens.refreshToken().isBlank());
    }

    private GoogleIdentity resolveLinkIdentity(GoogleTokenResponse tokens, String nonce) {
        if (tokens.idToken() != null && !tokens.idToken().isBlank()) {
            return oauthClient.verifyIdTokenForLink(tokens.idToken(), nonce);
        }
        if (tokens.accessToken() == null || tokens.accessToken().isBlank()) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
        }
        return oauthClient.fetchIdentityFromAccessToken(tokens.accessToken());
    }

    @Transactional
    public void link(
            Long userId,
            GoogleIdentity googleIdentity,
            GoogleTokenResponse tokens,
            Collection<String> requestedScopes) {
        UserAccount user = userRepository.findById(userId)
                .orElseThrow(() -> new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN));
        identityRepository.findByProviderAndProviderSubAndUnlinkedAtIsNull("google", googleIdentity.subject())
                .filter(identity -> !identity.getUser().getId().equals(userId))
                .ifPresent(identity -> {
                    throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_ACCOUNT_ALREADY_LINKED);
                });
        identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(userId, "google")
                .filter(identity -> !identity.getProviderSub().equals(googleIdentity.subject()))
                .ifPresent(identity -> {
                    throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_ACCOUNT_ALREADY_LINKED);
                });

        upsertIdentity(user, googleIdentity);
        upsertGrant(userId, googleIdentity.subject(), tokens, requestedScopes);
        redisStore.clearAccessTokens(userId);
        log.info("event=GOOGLE_LINK_COMPLETED traceId={} userId={}", MDC.get("traceId"), userId);
    }

    @Transactional(readOnly = true)
    public boolean hasScope(Long userId, String scope) {
        if (scope == null || scope.isBlank()) {
            return false;
        }
        return grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .map(grant -> grant.getGrantedScopes() != null && grant.getGrantedScopes().contains(scope))
                .orElse(false);
    }

    @Transactional(readOnly = true)
    public Optional<String> resolveGoogleProviderEmail(Long userId) {
        return identityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(userId, "google")
                .map(identity -> identity.getProviderEmail())
                .filter(email -> email != null && !email.isBlank());
    }

    public Optional<String> resolveGoogleDisplayName(Long userId) {
        return identityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(userId, "google")
                .map(UserIdentity::getDisplayName)
                .map(String::trim)
                .filter(name -> !name.isBlank());
    }

    @Transactional(readOnly = true)
    public GoogleStatusResponse status(Long userId) {
        UserIdentity identity = identityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(userId, "google")
                .orElse(null);
        GoogleOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId).orElse(null);
        List<String> granted = grant == null ? List.of() : sorted(grant.getGrantedScopes());
        List<String> missing = GoogleScopes.SUPPORTED_ADDITIONAL.stream()
                .filter(scope -> !granted.contains(scope))
                .toList();
        return new GoogleStatusResponse(
                identity != null,
                identity == null ? null : identity.getProviderEmail(),
                granted,
                missing);
    }

    @Transactional
    public void revokeGrant(Long userId) {
        GoogleOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId).orElse(null);
        if (grant == null) {
            redisStore.clearAccessTokens(userId);
            return;
        }
        String refreshToken = decrypt(grant);
        try {
            oauthClient.revokeToken(refreshToken);
        } finally {
            grant.setRevokedAt(Instant.now());
            grant.setUpdatedAt(Instant.now());
            grantRepository.save(grant);
            redisStore.clearAccessTokens(userId);
        }
        log.info("event=GOOGLE_GRANT_REVOKED traceId={} userId={}", MDC.get("traceId"), userId);
    }

    @Transactional
    public void unlinkIdentity(Long userId) {
        UserAccount user = userRepository.findById(userId)
                .orElseThrow(() -> new GoogleOAuthException(GoogleOAuthError.GOOGLE_INTERNAL_CALL_FORBIDDEN));
        UserIdentity identity = identityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(userId, "google")
                .orElse(null);
        if (identity == null) {
            return;
        }
        if (user.getPasswordHash() == null || user.getPasswordHash().isBlank()) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_CANNOT_UNLINK_LAST_IDENTITY);
        }
        GoogleOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId).orElse(null);
        if (grant != null) {
            try {
                oauthClient.revokeToken(decrypt(grant));
            } finally {
                grant.setRevokedAt(Instant.now());
                grant.setUpdatedAt(Instant.now());
                grantRepository.save(grant);
            }
        }
        identity.setUnlinkedAt(Instant.now());
        identityRepository.save(identity);
        if ("google".equals(user.getAuthProviderPrimary())) {
            user.setAuthProviderPrimary("local");
            userRepository.save(user);
        }
        redisStore.clearAccessTokens(userId);
        log.info("event=GOOGLE_IDENTITY_UNLINKED traceId={} userId={}", MDC.get("traceId"), userId);
    }

    @Transactional
    public InternalGoogleAccessTokenResponse accessToken(Long userId, Collection<String> requiredScopes) {
        List<String> required = validateScopes(requiredScopes);
        GoogleOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .orElseThrow(() -> missingScopes(required));
        Set<String> granted = new LinkedHashSet<>(grant.getGrantedScopes());
        List<String> missing = required.stream().filter(scope -> !granted.contains(scope)).toList();
        if (!missing.isEmpty()) {
            throw missingScopes(missing);
        }
        String scopeHash = redisStore.scopeHash(required);
        String cached = redisStore.getAccessToken(userId, scopeHash);
        if (cached != null && !cached.isBlank()) {
            return new InternalGoogleAccessTokenResponse(cached, MAX_ACCESS_TOKEN_TTL.toSeconds());
        }
        GoogleTokenResponse refreshed;
        try {
            refreshed = oauthClient.refreshAccessToken(decrypt(grant));
        } catch (GoogleOAuthException ex) {
            if (ex.error() == GoogleOAuthError.GOOGLE_REFRESH_TOKEN_REVOKED) {
                grant.setRevokedAt(Instant.now());
                grant.setUpdatedAt(Instant.now());
                grantRepository.save(grant);
                redisStore.clearAccessTokens(userId);
            }
            throw ex;
        }
        if (refreshed.accessToken() == null || refreshed.accessToken().isBlank()) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
        }
        long providerTtl = refreshed.expiresIn() == null ? 3600 : refreshed.expiresIn();
        Duration ttl = Duration.ofSeconds(Math.max(1, Math.min(MAX_ACCESS_TOKEN_TTL.toSeconds(), providerTtl - 30)));
        redisStore.saveAccessToken(userId, scopeHash, refreshed.accessToken(), ttl);
        log.info("event=GOOGLE_ACCESS_TOKEN_ISSUED traceId={} userId={} scopeCount={}",
                MDC.get("traceId"), userId, required.size());
        return new InternalGoogleAccessTokenResponse(refreshed.accessToken(), ttl.toSeconds());
    }

    private void upsertIdentity(UserAccount user, GoogleIdentity googleIdentity) {
        UserIdentity identity = identityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(user.getId(), "google")
                .orElseGet(() -> identityRepository
                        .findFirstByProviderAndProviderSubOrderByLinkedAtDesc("google", googleIdentity.subject())
                        .filter(existing -> existing.getUser().getId().equals(user.getId()))
                        .orElseGet(UserIdentity::new));
        identity.setUser(user);
        identity.setProvider("google");
        identity.setProviderSub(googleIdentity.subject());
        identity.setProviderEmail(googleIdentity.email());
        identity.setEmailVerified(googleIdentity.emailVerified());
        identity.setDisplayName(googleIdentity.displayName());
        identity.setAvatarUrl(googleIdentity.avatarUrl());
        identity.setLinkedAt(Instant.now());
        identity.setLastLoginAt(Instant.now());
        identity.setUnlinkedAt(null);
        identityRepository.save(identity);
    }

    private void upsertGrant(
            Long userId,
            String googleSub,
            GoogleTokenResponse tokens,
            Collection<String> requestedScopes) {
        GoogleOAuthGrant grant = grantRepository.findByUserIdAndRevokedAtIsNull(userId)
                .orElseGet(() -> grantRepository.findFirstByUserIdOrderByUpdatedAtDesc(userId)
                        .orElseGet(GoogleOAuthGrant::new));
        grantRepository.findByGoogleSubAndRevokedAtIsNull(googleSub)
                .filter(existing -> !existing.getUserId().equals(userId))
                .ifPresent(existing -> {
                    throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_ACCOUNT_ALREADY_LINKED);
                });
        grant.setUserId(userId);
        grant.setGoogleSub(googleSub);
        Set<String> merged = new LinkedHashSet<>(GoogleScopes.IDENTITY);
        if (tokens.scope() != null && !tokens.scope().isBlank()) {
            merged.addAll(List.of(tokens.scope().trim().split("\\s+")));
        } else if (requestedScopes != null && !requestedScopes.isEmpty()) {
            log.warn(
                    "event=GOOGLE_LINK_SCOPE_FALLBACK userId={} requestedCount={}",
                    userId,
                    requestedScopes.size());
            merged.addAll(requestedScopes);
        } else if (grant.getGrantedScopes() != null) {
            merged.addAll(grant.getGrantedScopes());
        }
        grant.setGrantedScopes(sorted(merged));
        if (tokens.refreshToken() != null && !tokens.refreshToken().isBlank()) {
            GoogleTokenCipher.EncryptedToken encrypted = tokenCipher.encrypt(tokens.refreshToken());
            grant.setEncryptedRefreshToken(encrypted.ciphertext());
            grant.setTokenIv(encrypted.iv());
            grant.setTokenKid(encrypted.kid());
        }
        if (grant.getEncryptedRefreshToken() == null) {
            log.warn("event=GOOGLE_LINK_GRANT_FAILED reason=missing_refresh_token userId={}",
                    userId);
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
        }
        Instant now = Instant.now();
        if (grant.getCreatedAt() == null) {
            grant.setCreatedAt(now);
        }
        grant.setUpdatedAt(now);
        grant.setRevokedAt(null);
        grantRepository.save(grant);
    }

    private String decrypt(GoogleOAuthGrant grant) {
        return tokenCipher.decrypt(
                grant.getEncryptedRefreshToken(), grant.getTokenIv(), grant.getTokenKid());
    }

    private List<String> validateScopes(Collection<String> scopes) {
        if (scopes == null) {
            return List.of();
        }
        List<String> normalized = scopes.stream()
                .filter(scope -> scope != null && !scope.isBlank())
                .map(String::trim)
                .distinct()
                .toList();
        if (!GoogleScopes.SUPPORTED_ADDITIONAL.containsAll(normalized)) {
            throw new IllegalArgumentException("Unsupported Google OAuth scope");
        }
        return normalized;
    }

    private GoogleOAuthException missingScopes(Collection<String> scopes) {
        return new GoogleOAuthException(
                GoogleOAuthError.GOOGLE_SCOPE_MISSING,
                Map.of("missingScopes", List.copyOf(scopes)));
    }

    private URI errorRedirect(GoogleOAuthError error) {
        return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                .path("/settings/integrations/google/error")
                .queryParam("errorCode", error.name())
                .build().encode().toUri();
    }

    private String validateRedirectAfter(String redirectAfter) {
        if (redirectAfter == null || redirectAfter.isBlank()) {
            return "/";
        }
        if (redirectAfter.startsWith("/") && !redirectAfter.startsWith("//")) {
            return redirectAfter;
        }
        throw new IllegalArgumentException("redirectAfter is not allowed");
    }

    private List<String> sorted(Collection<String> values) {
        return values == null ? List.of() : values.stream().sorted().toList();
    }

    private String randomToken(int bytes) {
        byte[] value = new byte[bytes];
        secureRandom.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }
}
