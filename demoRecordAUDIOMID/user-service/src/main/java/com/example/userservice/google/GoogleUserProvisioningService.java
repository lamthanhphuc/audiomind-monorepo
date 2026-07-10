package com.example.userservice.google;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class GoogleUserProvisioningService {

    private static final String PROVIDER = "google";

    private final UserAccountRepository userAccountRepository;
    private final UserIdentityRepository userIdentityRepository;
    private final UserPlanService userPlanService;

    public GoogleUserProvisioningService(
            UserAccountRepository userAccountRepository,
            UserIdentityRepository userIdentityRepository,
            UserPlanService userPlanService) {
        this.userAccountRepository = userAccountRepository;
        this.userIdentityRepository = userIdentityRepository;
        this.userPlanService = userPlanService;
    }

    @Transactional
    public UserAccount findOrCreate(GoogleIdentity googleIdentity) {
        return userIdentityRepository
                .findByProviderAndProviderSubAndUnlinkedAtIsNull(PROVIDER, googleIdentity.subject())
                .map(identity -> updateExistingIdentity(identity, googleIdentity))
                .orElseGet(() -> createGoogleUser(googleIdentity));
    }

    private UserAccount updateExistingIdentity(UserIdentity identity, GoogleIdentity googleIdentity) {
        identity.setProviderEmail(googleIdentity.email());
        identity.setEmailVerified(googleIdentity.emailVerified());
        identity.setDisplayName(googleIdentity.displayName());
        identity.setAvatarUrl(googleIdentity.avatarUrl());
        identity.setLastLoginAt(Instant.now());
        userIdentityRepository.save(identity);
        return identity.getUser();
    }

    private UserAccount createGoogleUser(GoogleIdentity googleIdentity) {
        if (userAccountRepository.findByEmailIgnoreCase(googleIdentity.email()).isPresent()) {
            throw new GoogleOAuthException(GoogleOAuthError.GOOGLE_EMAIL_CONFLICT);
        }

        UserAccount user = new UserAccount();
        user.setUsername(createGoogleUsername(googleIdentity.subject()));
        user.setEmail(googleIdentity.email());
        user.setPasswordHash(null);
        user.setAuthProviderPrimary(PROVIDER);
        userPlanService.applyNewUserTrial(user);
        UserAccount savedUser = userAccountRepository.save(user);

        Instant now = Instant.now();
        UserIdentity identity = new UserIdentity();
        identity.setUser(savedUser);
        identity.setProvider(PROVIDER);
        identity.setProviderSub(googleIdentity.subject());
        identity.setProviderEmail(googleIdentity.email());
        identity.setEmailVerified(googleIdentity.emailVerified());
        identity.setDisplayName(googleIdentity.displayName());
        identity.setAvatarUrl(googleIdentity.avatarUrl());
        identity.setLinkedAt(now);
        identity.setLastLoginAt(now);
        userIdentityRepository.save(identity);
        return savedUser;
    }

    private String createGoogleUsername(String subject) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(subject.getBytes(StandardCharsets.UTF_8));
            return "google_" + HexFormat.of().formatHex(digest, 0, 12);
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 is unavailable", ex);
        }
    }
}
