package com.example.userservice.controller;

import com.example.userservice.plan.SubscriptionPlanService;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/plans")
@RequiredArgsConstructor
public class PlanController {

    private final SubscriptionPlanService subscriptionPlanService;

    @GetMapping
    public Map<String, Object> list() {
        return Map.of("items", subscriptionPlanService.listActive().stream()
                .map(subscriptionPlanService::toView)
                .toList());
    }
}
