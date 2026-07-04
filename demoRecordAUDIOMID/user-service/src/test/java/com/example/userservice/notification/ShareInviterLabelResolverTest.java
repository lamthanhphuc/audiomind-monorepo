package com.example.userservice.notification;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.repository.UserIdentityRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class ShareInviterLabelResolverTest {

    @Mock
    private UserIdentityRepository identityRepository;

    @InjectMocks
    private ShareInviterLabelResolver resolver;

    @Test
    void resolve_prefersGoogleDisplayNameOverSyntheticUsername() {
        UserAccount inviter = new UserAccount();
        inviter.setId(1L);
        inviter.setUsername("google_8a57a4bb086185e4c2bba3c9");
        inviter.setEmail("phucthanhlam050204@gmail.com");

        UserIdentity identity = new UserIdentity();
        identity.setDisplayName("Phuc Thanh Lam");
        identity.setProviderEmail("phucthanhlam050204@gmail.com");
        when(identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(1L, "google"))
                .thenReturn(Optional.of(identity));

        assertThat(resolver.resolve(inviter)).isEqualTo("Phuc Thanh Lam");
    }

    @Test
    void resolve_sanitizesClassPrefixFromGoogleDisplayName() {
        UserAccount inviter = new UserAccount();
        inviter.setId(3L);
        inviter.setUsername("google_hash");
        inviter.setEmail("phucthanhlam050204@gmail.com");

        UserIdentity identity = new UserIdentity();
        identity.setDisplayName("12A1-17 Lâm Thanh Phúc");
        when(identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(3L, "google"))
                .thenReturn(Optional.of(identity));

        assertThat(resolver.resolve(inviter)).isEqualTo("Lâm Thanh Phúc");
    }

    @Test
    void resolve_fallsBackToEmailWhenNoGoogleIdentity() {
        UserAccount inviter = new UserAccount();
        inviter.setId(2L);
        inviter.setUsername("google_abc");
        inviter.setEmail("owner@example.com");
        when(identityRepository.findByUserIdAndProviderAndUnlinkedAtIsNull(2L, "google"))
                .thenReturn(Optional.empty());

        assertThat(resolver.resolve(inviter)).isEqualTo("owner");
    }
}
