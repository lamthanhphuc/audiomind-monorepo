package com.example.userservice.plan;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.UserAccountRepository;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;

@ExtendWith(MockitoExtension.class)
class UserPlanServiceTest {

    @Mock
    private UserAccountRepository userAccountRepository;

    @InjectMocks
    private UserPlanService userPlanService;

    private final Instant now = Instant.parse("2026-07-10T04:00:00Z");

    @BeforeEach
    void setUp() {
        ReflectionTestUtils.setField(userPlanService, "clock", Clock.fixed(now, ZoneOffset.UTC));
        ReflectionTestUtils.setField(userPlanService, "newUserTrialDays", 3);
    }

    @Test
    void applyNewUserTrial_setsStandardPlanWithExpiry() {
        UserAccount user = new UserAccount();

        userPlanService.applyNewUserTrial(user);

        assertEquals("STANDARD", user.getPlan());
        assertEquals(now.plusSeconds(3 * 24 * 60 * 60), user.getPlanExpiresAt());
    }

    @Test
    void resolveEffectivePlan_returnsFreeWhenTrialExpired() {
        UserAccount user = new UserAccount();
        user.setPlan("PRO");
        user.setPlanExpiresAt(now.minusSeconds(1));

        assertEquals("FREE", userPlanService.resolveEffectivePlan(user));
        assertTrue(userPlanService.isOnTrial(user) == false);
    }

    @Test
    void refreshExpiredPlan_downgradesExpiredTrialUser() {
        UserAccount user = new UserAccount();
        user.setId(9L);
        user.setPlan("PRO");
        user.setPlanExpiresAt(now.minusSeconds(30));
        when(userAccountRepository.save(user)).thenAnswer(invocation -> invocation.getArgument(0));

        UserAccount refreshed = userPlanService.refreshExpiredPlan(user);

        assertEquals("FREE", refreshed.getPlan());
        assertNull(refreshed.getPlanExpiresAt());
        verify(userAccountRepository).save(user);
    }

    @Test
    void markPermanentPro_mapsLegacyCallToStandardAndClearsExpiry() {
        UserAccount user = new UserAccount();
        user.setPlan("FREE");
        user.setPlanExpiresAt(now.plusSeconds(3600));

        userPlanService.markPermanentPro(user);

        assertEquals("STANDARD", user.getPlan());
        assertNull(user.getPlanExpiresAt());
        assertTrue(userPlanService.hasPermanentPro(user));
    }

    @Test
    void isOnTrial_trueForActiveTrial() {
        UserAccount user = new UserAccount();
        user.setPlan("PRO");
        user.setPlanExpiresAt(now.plusSeconds(3600));

        assertTrue(userPlanService.isOnTrial(user));
        assertEquals("STANDARD", userPlanService.resolveEffectivePlan(user));
    }
}
