package com.example.userservice.google;

import com.example.userservice.client.PendingMeetingShareClient;
import com.example.userservice.controller.dto.GoogleLoginUserResponse;
import com.example.userservice.controller.dto.GoogleTicketExchangeResponse;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import com.example.userservice.security.JwtUtil;
import java.net.URI;
import java.security.SecureRandom;
import java.util.Base64;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.util.UriComponentsBuilder;

@Service
public class GoogleLoginService {

    private static final Logger log = LoggerFactory.getLogger(GoogleLoginService.class);

    private final GoogleOAuthProperties properties;
    private final GoogleOAuthRedisStore redisStore;
    private final GoogleOAuthClient googleOAuthClient;
    private final GoogleUserProvisioningService provisioningService;
    private final UserAccountRepository userAccountRepository;
    private final UserIdentityRepository userIdentityRepository;
    private final JwtUtil jwtUtil;
    private final PendingMeetingShareClient pendingMeetingShareClient;
    private final UserPlanService userPlanService;
    private final SecureRandom secureRandom = new SecureRandom();
    private final long accessExpirationSeconds;

    public GoogleLoginService(
            GoogleOAuthProperties properties,
            GoogleOAuthRedisStore redisStore,
            GoogleOAuthClient googleOAuthClient,
            GoogleUserProvisioningService provisioningService,
            UserAccountRepository userAccountRepository,
            UserIdentityRepository userIdentityRepository,
            JwtUtil jwtUtil,
            PendingMeetingShareClient pendingMeetingShareClient,
            UserPlanService userPlanService,
            @Value("${app.security.jwt.access-expiration-seconds}") long accessExpirationSeconds) {
        this.properties = properties;
        this.redisStore = redisStore;
        this.googleOAuthClient = googleOAuthClient;
        this.provisioningService = provisioningService;
        this.userAccountRepository = userAccountRepository;
        this.userIdentityRepository = userIdentityRepository;
        this.jwtUtil = jwtUtil;
        this.pendingMeetingShareClient = pendingMeetingShareClient;
        this.userPlanService = userPlanService;
        this.accessExpirationSeconds = accessExpirationSeconds;
    }

    public URI startLogin(String redirectAfter) {
        properties.requireConfigured();
        String safeRedirectAfter = validateRedirectAfter(redirectAfter);
        String state = randomToken(32);
        String nonce = randomToken(32);
        redisStore.saveState(state, nonce, safeRedirectAfter);

        log.info("event=GOOGLE_LOGIN_STARTED traceId={} mode=login", MDC.get("traceId"));
        return GoogleOAuthAuthorizationUrls.buildLoginAuthorization(properties, state, nonce);
    }

    public URI handleCallback(String code, String state, String providerError) {
        properties.requireConfigured();
        GoogleLoginState loginState = redisStore.consumeState(state);
        if (providerError != null || code == null || code.isBlank()) {
            return errorRedirect(GoogleOAuthError.GOOGLE_OAUTH_PROVIDER_ERROR);
        }

        try {
            GoogleTokenResponse tokenResponse = googleOAuthClient.exchangeCode(code);
            GoogleIdentity googleIdentity = googleOAuthClient.verifyIdToken(tokenResponse.idToken(), loginState.nonce());
            UserAccount user = provisioningService.findOrCreate(googleIdentity);
            pendingMeetingShareClient.acceptPendingInvites(user.getId(), user.getEmail());
            log.info(
                    "event=GOOGLE_LOGIN_PENDING_SHARE_ACCEPTED userId={} email={}",
                    user.getId(),
                    user.getEmail());
            String ticket = randomToken(32);
            redisStore.saveTicket(ticket, user.getId(), loginState.redirectAfter());
            log.info(
                    "event=GOOGLE_LOGIN_CALLBACK_COMPLETED traceId={} userId={} mode=login",
                    MDC.get("traceId"),
                    user.getId());
            return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                    .path("/auth/google/success")
                    .queryParam("ticket", ticket)
                    .build()
                    .encode()
                    .toUri();
        } catch (GoogleOAuthException ex) {
            log.warn(
                    "event=GOOGLE_LOGIN_CALLBACK_FAILED traceId={} errorCode={}",
                    MDC.get("traceId"),
                    ex.error().name());
            return errorRedirect(ex.error());
        }
    }

    @Transactional
    public GoogleTicketExchangeResponse exchangeTicket(String rawTicket) {
        properties.requireConfigured();
        GoogleLoginTicket loginTicket = redisStore.consumeTicket(rawTicket);
        UserAccount user = userAccountRepository.findById(loginTicket.userId())
                .orElseThrow(() -> new GoogleOAuthException(GoogleOAuthError.GOOGLE_LOGIN_TICKET_INVALID));
        UserAccount currentUser = userPlanService.refreshExpiredPlan(user);
        String effectivePlan = userPlanService.resolveEffectivePlan(currentUser);
        String displayName = userIdentityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(currentUser.getId(), "google")
                .map(UserIdentity::getDisplayName)
                .filter(value -> !value.isBlank())
                .orElse(currentUser.getUsername());
        String accessToken = jwtUtil.createAccessToken(
                currentUser.getId(),
                currentUser.getUsername(),
                currentUser.getRole(),
                effectivePlan
        );
        log.info(
                "event=GOOGLE_LOGIN_TICKET_EXCHANGED traceId={} userId={}",
                MDC.get("traceId"),
                user.getId());
        return new GoogleTicketExchangeResponse(
                accessToken,
                accessExpirationSeconds,
                new GoogleLoginUserResponse(currentUser.getId(), currentUser.getEmail(), displayName),
                loginTicket.redirectAfter());
    }

    private URI errorRedirect(GoogleOAuthError error) {
        return UriComponentsBuilder.fromUriString(properties.getFrontendBaseUrl())
                .path("/auth/google/error")
                .queryParam("errorCode", error.name())
                .build()
                .encode()
                .toUri();
    }

    private String validateRedirectAfter(String redirectAfter) {
        if (redirectAfter == null || redirectAfter.isBlank()) {
            return "/";
        }
        if (redirectAfter.startsWith("/") && !redirectAfter.startsWith("//")) {
            return redirectAfter;
        }
        try {
            URI uri = URI.create(redirectAfter);
            String origin = uri.getScheme() + "://" + uri.getAuthority();
            if (properties.getAllowedRedirectOrigins().contains(origin)) {
                return redirectAfter;
            }
        } catch (IllegalArgumentException ignored) {
            // handled below
        }
        throw new IllegalArgumentException("redirect_after is not allowed");
    }

    private String randomToken(int bytes) {
        byte[] value = new byte[bytes];
        secureRandom.nextBytes(value);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
    }
}
