package com.example.userservice.controller;

import com.example.userservice.advertising.AdvertisementService;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.security.UserPrincipal;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/advertisements")
@RequiredArgsConstructor
public class AdvertisementController {

    private final AdvertisementService advertisementService;
    private final SubscriptionPlanService subscriptionPlanService;
    private final UserPlanService userPlanService;

    @GetMapping
    public Map<String, Object> list(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        UserAccount user = userPlanService.requireUserWithCurrentPlan(principal.userId());
        String plan = userPlanService.resolveEffectivePlan(user);
        boolean adsEnabled = subscriptionPlanService.requireByCode(plan).isAdvertisementEnabled();
        if (!adsEnabled) {
            return Map.of("plan", plan, "advertisementEnabled", false, "items", List.of());
        }
        return Map.of(
                "plan", plan,
                "advertisementEnabled", true,
                "items", advertisementService.eligibleForPlan(plan).stream()
                        .map(advertisementService::toView)
                        .toList()
        );
    }

    private static UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }
}
