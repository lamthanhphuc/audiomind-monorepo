package com.example.userservice.notification;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.repository.UserIdentityRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;

@Component
@RequiredArgsConstructor
public class ShareInviterLabelResolver {

    private static final String GOOGLE_PROVIDER = "google";

    private final UserIdentityRepository identityRepository;

    public String resolve(UserAccount inviter) {
        if (inviter == null) {
            return "Một thành viên AudioMind";
        }
        return identityRepository
                .findByUserIdAndProviderAndUnlinkedAtIsNull(inviter.getId(), GOOGLE_PROVIDER)
                .map(this::labelFromGoogleIdentity)
                .filter(StringUtils::hasText)
                .orElseGet(() -> labelFromAccount(inviter));
    }

    private String labelFromGoogleIdentity(UserIdentity identity) {
        if (StringUtils.hasText(identity.getDisplayName())) {
            return HumanReadableLabel.sanitize(identity.getDisplayName());
        }
        if (StringUtils.hasText(identity.getProviderEmail())) {
            return HumanReadableLabel.sanitize(localPart(identity.getProviderEmail()));
        }
        return null;
    }

    private String labelFromAccount(UserAccount inviter) {
        if (StringUtils.hasText(inviter.getEmail())) {
            return HumanReadableLabel.sanitize(localPart(inviter.getEmail()));
        }
        String username = inviter.getUsername();
        if (StringUtils.hasText(username) && !username.startsWith("google_")) {
            return username.trim();
        }
        return "Một thành viên AudioMind";
    }

    private String localPart(String email) {
        int at = email.indexOf('@');
        if (at <= 0) {
            return email.trim();
        }
        return email.substring(0, at).replace('.', ' ').trim();
    }
}
