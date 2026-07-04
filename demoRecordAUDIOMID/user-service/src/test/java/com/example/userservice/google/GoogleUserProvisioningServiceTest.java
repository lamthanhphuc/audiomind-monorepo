package com.example.userservice.google;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.UserIdentity;
import com.example.userservice.repository.UserAccountRepository;
import com.example.userservice.repository.UserIdentityRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

@ExtendWith(MockitoExtension.class)
class GoogleUserProvisioningServiceTest {

    @Mock
    private UserAccountRepository userAccountRepository;

    @Mock
    private UserIdentityRepository userIdentityRepository;

    @Test
    void createsGoogleOnlyUserAndIdentity() {
        GoogleUserProvisioningService service = new GoogleUserProvisioningService(
                userAccountRepository,
                userIdentityRepository);
        GoogleIdentity googleIdentity = new GoogleIdentity(
                "google-sub-1",
                "new@example.com",
                true,
                "New User",
                "https://example.com/avatar.png");
        when(userIdentityRepository.findByProviderAndProviderSubAndUnlinkedAtIsNull("google", "google-sub-1"))
                .thenReturn(Optional.empty());
        when(userAccountRepository.findByEmailIgnoreCase("new@example.com")).thenReturn(Optional.empty());
        when(userAccountRepository.save(any(UserAccount.class))).thenAnswer(invocation -> {
            UserAccount user = invocation.getArgument(0);
            user.setId(41L);
            return user;
        });

        UserAccount user = service.findOrCreate(googleIdentity);

        assertEquals(41L, user.getId());
        assertEquals("google", user.getAuthProviderPrimary());
        assertNull(user.getPasswordHash());
        ArgumentCaptor<UserIdentity> identityCaptor = ArgumentCaptor.forClass(UserIdentity.class);
        verify(userIdentityRepository).save(identityCaptor.capture());
        assertEquals("google-sub-1", identityCaptor.getValue().getProviderSub());
        assertEquals(41L, identityCaptor.getValue().getUser().getId());
    }

    @Test
    void rejectsEmailCollisionWithoutAutoMerge() {
        GoogleUserProvisioningService service = new GoogleUserProvisioningService(
                userAccountRepository,
                userIdentityRepository);
        GoogleIdentity googleIdentity = new GoogleIdentity(
                "google-sub-2",
                "local@example.com",
                true,
                "Local User",
                null);
        when(userIdentityRepository.findByProviderAndProviderSubAndUnlinkedAtIsNull("google", "google-sub-2"))
                .thenReturn(Optional.empty());
        when(userAccountRepository.findByEmailIgnoreCase("local@example.com"))
                .thenReturn(Optional.of(new UserAccount()));

        GoogleOAuthException exception = assertThrows(
                GoogleOAuthException.class,
                () -> service.findOrCreate(googleIdentity));

        assertEquals(GoogleOAuthError.GOOGLE_EMAIL_CONFLICT, exception.error());
    }
}
