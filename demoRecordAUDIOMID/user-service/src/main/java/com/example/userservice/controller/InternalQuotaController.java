package com.example.userservice.controller;

import com.example.userservice.quota.QuotaService;
import com.example.userservice.quota.QuotaService.QuotaConsumeResult;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.plan.UserPlanService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import java.util.LinkedHashMap;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/internal/quota")
@RequiredArgsConstructor
public class InternalQuotaController {

    private final QuotaService quotaService;
    private final UserPlanService userPlanService;
    private final SubscriptionPlanService subscriptionPlanService;

    @Value("${app.internal.service-token:}")
    private String internalServiceToken;

    @PostMapping("/consume")
    public Map<String, Object> consume(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @Valid @RequestBody ConsumeRequest request
    ) {
        requireInternalToken(token);
        QuotaConsumeResult result = quotaService.consume(
                request.userId(),
                request.sttSecondsDelta() == null ? 0 : request.sttSecondsDelta(),
                request.geminiCharsDelta() == null ? 0 : request.geminiCharsDelta(),
                request.idempotencyKey(),
                request.quotaType()
        );
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("allowed", result.allowed());
        body.put("status", result.status());
        body.put("periodYyyymm", result.periodYyyymm());
        body.put("sttSecondsUsed", result.sttSecondsUsed());
        body.put("geminiInputCharsUsed", result.geminiInputCharsUsed());
        body.put("sttSecondsLimit", result.sttSecondsLimit());
        body.put("geminiInputCharsLimit", result.geminiInputCharsLimit());
        return body;
    }

    @PostMapping("/authorize-feature")
    public Map<String, Object> authorizeFeature(
            @RequestHeader(name = "X-Internal-Service-Token", required = false) String token,
            @Valid @RequestBody FeatureAuthorizationRequest request
    ) {
        requireInternalToken(token);
        UserAccount user = userPlanService.requireUserWithCurrentPlan(request.userId());
        String plan = userPlanService.resolveEffectivePlan(user);
        boolean allowed = subscriptionPlanService.featureEnabled(plan, request.feature());
        return Map.of(
                "allowed", allowed,
                "plan", plan,
                "feature", request.feature()
        );
    }

    private void requireInternalToken(String token) {
        if (internalServiceToken == null || internalServiceToken.isBlank()) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Internal token not configured");
        }
        if (token == null || token.isBlank() || !internalServiceToken.equals(token)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
    }

    public record ConsumeRequest(
            @NotNull @Min(1) Long userId,
            @Min(0) Long sttSecondsDelta,
            @Min(0) Long geminiCharsDelta,
            String idempotencyKey,
            String quotaType
    ) {
    }

    public record FeatureAuthorizationRequest(
            @NotNull @Min(1) Long userId,
            @NotBlank String feature
    ) {
    }
}
