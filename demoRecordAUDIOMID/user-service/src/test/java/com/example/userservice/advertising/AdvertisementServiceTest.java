package com.example.userservice.advertising;

import com.example.userservice.entity.Advertisement;
import com.example.userservice.entity.SubscriptionPlan;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.repository.AdvertisementRepository;
import java.time.Instant;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.InjectMocks;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.web.server.ResponseStatusException;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

@ExtendWith(MockitoExtension.class)
class AdvertisementServiceTest {

    @Mock
    private AdvertisementRepository advertisementRepository;

    @Mock
    private SubscriptionPlanService subscriptionPlanService;

    @InjectMocks
    private AdvertisementService service;

    @Test
    void eligibleForPlan_servesActiveScheduledAdsForFree() {
        when(subscriptionPlanService.requireByCode("FREE")).thenReturn(plan("FREE", true));
        Advertisement freeAd = ad("Free ad", "FREE", "ACTIVE");
        Advertisement premiumAd = ad("Premium only", "PREMIUM", "ACTIVE");
        Advertisement expiredAd = ad("Expired", "FREE", "ACTIVE");
        expiredAd.setEndAt(Instant.now().minusSeconds(60));
        Advertisement futureAd = ad("Future", "FREE", "ACTIVE");
        futureAd.setStartAt(Instant.now().plusSeconds(60));
        when(advertisementRepository.findByStatusIgnoreCaseOrderByUpdatedAtDescIdDesc("ACTIVE"))
                .thenReturn(List.of(freeAd, premiumAd, expiredAd, futureAd));

        List<Advertisement> ads = service.eligibleForPlan("FREE");

        assertEquals(1, ads.size());
        assertEquals("Free ad", ads.get(0).getTitle());
    }

    @Test
    void eligibleForPlan_returnsEmptyForAdFreePlan() {
        when(subscriptionPlanService.requireByCode("PREMIUM")).thenReturn(plan("PREMIUM", false));

        List<Advertisement> ads = service.eligibleForPlan("PREMIUM");

        assertTrue(ads.isEmpty());
        verify(advertisementRepository, never()).findByStatusIgnoreCaseOrderByUpdatedAtDescIdDesc(any());
    }

    @Test
    void create_rejectsActiveAdvertisementWithoutMedia() {
        when(subscriptionPlanService.requireByCode("FREE")).thenReturn(plan("FREE", true));

        AdvertisementService.AdvertisementRequest request = new AdvertisementService.AdvertisementRequest(
                "TechLearn",
                "Sponsored course",
                "Upgrade your workflow",
                null,
                null,
                "https://example.com",
                "BANNER",
                "POST_ANALYSIS",
                null,
                "ACTIVE",
                List.of("FREE"),
                null,
                null);

        ResponseStatusException ex = assertThrows(ResponseStatusException.class, () -> service.create(request));

        assertEquals(400, ex.getStatusCode().value());
        assertTrue(ex.getReason().contains("media URL"));
    }

    @Test
    void create_rejectsActiveVideoWithoutDuration() {
        when(subscriptionPlanService.requireByCode("FREE")).thenReturn(plan("FREE", true));

        AdvertisementService.AdvertisementRequest request = new AdvertisementService.AdvertisementRequest(
                "TechLearn",
                "Sponsored course",
                "Upgrade your workflow",
                "https://cdn.example.com/ad.mp4",
                null,
                "https://example.com",
                "VIDEO",
                "POST_ANALYSIS",
                null,
                "ACTIVE",
                List.of("FREE"),
                null,
                null);

        ResponseStatusException ex = assertThrows(ResponseStatusException.class, () -> service.create(request));

        assertEquals(400, ex.getStatusCode().value());
        assertTrue(ex.getReason().contains("Video duration"));
    }

    @Test
    void create_defaultsTargetPlansToFree() {
        when(subscriptionPlanService.requireByCode("FREE")).thenReturn(plan("FREE", true));
        when(advertisementRepository.save(any(Advertisement.class))).thenAnswer(invocation -> invocation.getArgument(0));

        Advertisement saved = service.create(new AdvertisementService.AdvertisementRequest(
                "TechLearn",
                "Banner",
                "Study faster",
                "https://cdn.example.com/banner.png",
                null,
                "https://example.com",
                "BANNER",
                "DASHBOARD",
                null,
                "DRAFT",
                List.of(),
                null,
                null));

        assertEquals("FREE", saved.getTargetPlans());
    }

    private static Advertisement ad(String title, String targetPlans, String status) {
        Advertisement ad = new Advertisement();
        ad.setBrandName("Brand");
        ad.setTitle(title);
        ad.setType("BANNER");
        ad.setPlacement("DASHBOARD");
        ad.setStatus(status);
        ad.setTargetPlans(targetPlans);
        return ad;
    }

    private static SubscriptionPlan plan(String code, boolean ads) {
        SubscriptionPlan plan = new SubscriptionPlan();
        plan.setCode(code);
        plan.setName(code);
        plan.setAdvertisementEnabled(ads);
        plan.setActive(true);
        return plan;
    }
}
