package com.example.userservice.plan;

import com.example.userservice.entity.SubscriptionPlan;
import com.example.userservice.repository.SubscriptionPlanRepository;
import com.example.userservice.repository.UserAccountRepository;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class SubscriptionPlanServiceTest {

    @Mock
    private SubscriptionPlanRepository planRepository;

    @Mock
    private UserAccountRepository userAccountRepository;

    @InjectMocks
    private SubscriptionPlanService service;

    @Test
    void create_normalizesCodeAndPersistsDatabaseConfiguration() {
        when(planRepository.existsByCodeIgnoreCase("STUDENT_PLUS")).thenReturn(false);
        when(planRepository.save(any(SubscriptionPlan.class))).thenAnswer(invocation -> invocation.getArgument(0));

        service.create(request(" student_plus ", 49000L, true));

        ArgumentCaptor<SubscriptionPlan> captor = ArgumentCaptor.forClass(SubscriptionPlan.class);
        verify(planRepository).save(captor.capture());
        SubscriptionPlan saved = captor.getValue();
        assertEquals("STUDENT_PLUS", saved.getCode());
        assertEquals(49000L, saved.getPriceVnd());
        assertTrue(saved.isAdvertisementEnabled());
        assertEquals(180L, saved.getRecordingMinutesLimit());
    }

    @Test
    void create_rejectsLegacyStudentCode() {
        assertThrows(ResponseStatusException.class, () -> service.create(request("student", 39000L, true)));
    }

    @Test
    void create_rejectsDuplicateCode() {
        when(planRepository.existsByCodeIgnoreCase("FAMILY")).thenReturn(true);

        assertThrows(ResponseStatusException.class, () -> service.create(request("family", 99000L, false)));
    }

    @Test
    void create_rejectsNegativePrice() {
        assertThrows(ResponseStatusException.class, () -> service.create(request("BETA", -1L, true)));
    }

    @Test
    void delete_blocksPlansThatStillHaveSubscribers() {
        SubscriptionPlan plan = plan("STUDENT", true);
        plan.setId(2L);
        when(planRepository.findById(2L)).thenReturn(Optional.of(plan));
        when(userAccountRepository.countByPlanIgnoreCase("STUDENT")).thenReturn(3L);

        ResponseStatusException ex = assertThrows(ResponseStatusException.class, () -> service.delete(2L));

        assertEquals(409, ex.getStatusCode().value());
        assertTrue(ex.getReason().contains("active subscriptions"));
    }

    @Test
    void limitsForPlan_readsQuotaFromDatabasePlan() {
        SubscriptionPlan standard = plan("STANDARD", false);
        standard.setRecordingMinutesLimit(600L);
        standard.setAiAnalysisLimit(2_000_000L);
        when(planRepository.findByCodeIgnoreCase("STANDARD")).thenReturn(Optional.of(standard));

        SubscriptionPlanService.PlanLimits limits = service.limitsForPlan("pro");

        assertEquals(36_000L, limits.sttSecondsMonthly());
        assertEquals(2_000_000L, limits.geminiInputCharsMonthly());
    }

    @Test
    void featureEnabled_readsNormalizedFeatureNameFromDatabase() {
        SubscriptionPlan premium = plan("PREMIUM", false);
        premium.setFeaturesJson("{\"subjectManagement\":true,\"quiz\":false}");
        when(planRepository.findByCodeIgnoreCase("PREMIUM")).thenReturn(Optional.of(premium));

        assertTrue(service.featureEnabled("premium", "subject_management"));
        assertEquals(false, service.featureEnabled("premium", "quiz"));
    }

    private static SubscriptionPlanService.PlanRequest request(String code, long price, boolean ads) {
        return new SubscriptionPlanService.PlanRequest(
                code,
                "Student Plus",
                "Higher student quota",
                price,
                "VND",
                "MONTHLY",
                ads,
                180L,
                700_000L,
                30L,
                100L,
                100L,
                20L,
                20L,
                "{\"subjectManagement\":true}",
                40,
                true);
    }

    private static SubscriptionPlan plan(String code, boolean ads) {
        SubscriptionPlan plan = new SubscriptionPlan();
        plan.setCode(code);
        plan.setName(code);
        plan.setCurrency("VND");
        plan.setBillingPeriod("MONTHLY");
        plan.setAdvertisementEnabled(ads);
        plan.setActive(true);
        return plan;
    }
}
