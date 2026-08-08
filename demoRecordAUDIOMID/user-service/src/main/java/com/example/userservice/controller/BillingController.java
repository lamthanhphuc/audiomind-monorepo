package com.example.userservice.controller;

import com.example.userservice.billing.BillingService;
import com.example.userservice.billing.payos.PayosModels;
import com.example.userservice.entity.BillingInvoice;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.quota.QuotaService;
import com.example.userservice.security.UserPrincipal;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.security.core.Authentication;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/billing")
@RequiredArgsConstructor
public class BillingController {

    private final BillingService billingService;
    private final QuotaService quotaService;
    private final UserPlanService userPlanService;
    private final SubscriptionPlanService subscriptionPlanService;

    @GetMapping("/me")
    public Map<String, Object> me(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        List<BillingInvoice> invoices = billingService.listMyInvoices(principal.userId());
        UserAccount user = userPlanService.requireUserWithCurrentPlan(principal.userId());
        QuotaService.QuotaSnapshot quota = quotaService.snapshot(principal.userId());
        Map<String, Object> response = new LinkedHashMap<>();
        response.put("userId", principal.userId());
        response.put("plan", quota.plan());
        response.put("jwtPlan", principal.plan());
        response.put("trialActive", userPlanService.isOnTrial(user));
        if (user.getPlanExpiresAt() != null) {
        response.put("planExpiresAt", user.getPlanExpiresAt());
        }
        response.put("quota", quota);
        response.put("invoices", invoices);
        List<Map<String, Object>> plans = subscriptionPlanService.listActive().stream()
                .map(subscriptionPlanService::toView)
                .toList();
        response.put("plans", plans);
        response.put("standardPriceVnd", priceForPlan(plans, UserPlanService.PLAN_STANDARD));
        response.put("premiumPriceVnd", priceForPlan(plans, UserPlanService.PLAN_PREMIUM));
        // Compatibility for older clients while /checkout/pro now activates STANDARD.
        response.put("proPriceVnd", priceForPlan(plans, UserPlanService.PLAN_STANDARD));
        response.put("advertisementEnabled", subscriptionPlanService.requireByCode(quota.plan()).isAdvertisementEnabled());
        response.put("payosEnabled", billingService.payosEnabled());
        return response;
    }

    @PostMapping("/checkout/student")
    public Map<String, Object> checkoutStudent(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        BillingInvoice invoice = billingService.createStudentCheckout(principal.userId());
        return checkoutPayload(invoice);
    }

    @PostMapping("/checkout/pro")
    public Map<String, Object> checkoutPro(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        BillingInvoice invoice = billingService.createProCheckout(principal.userId());
        return checkoutPayload(invoice);
    }

    @PostMapping("/checkout/{planCode}")
    public Map<String, Object> checkoutPlan(
            Authentication authentication,
            @PathVariable String planCode
    ) {
        UserPrincipal principal = requirePrincipal(authentication);
        BillingInvoice invoice = billingService.createCheckout(principal.userId(), planCode);
        return checkoutPayload(invoice);
    }

    private static Map<String, Object> checkoutPayload(BillingInvoice invoice) {
        return Map.of(
                "orderCode", invoice.getOrderCode(),
                "checkoutUrl", invoice.getCheckoutUrl(),
                "paymentLinkId", invoice.getPaymentLinkId(),
                "status", invoice.getStatus(),
                "amountVnd", invoice.getAmountVnd(),
                "planCode", invoice.getPlanCode()
        );
    }

    @GetMapping("/orders/{orderCode}")
    public Map<String, Object> orderStatus(
            Authentication authentication,
            @PathVariable long orderCode
    ) {
        UserPrincipal principal = requirePrincipal(authentication);
        BillingInvoice invoice = billingService.getInvoiceForUser(principal.userId(), orderCode);
        return invoicePayload(invoice);
    }

    @PostMapping("/orders/{orderCode}/sync")
    public Map<String, Object> syncOrder(
            Authentication authentication,
            @PathVariable long orderCode
    ) {
        UserPrincipal principal = requirePrincipal(authentication);
        BillingInvoice invoice = billingService.syncProPayment(principal.userId(), orderCode);
        return invoicePayload(invoice);
    }

    @PostMapping("/payos/webhook")
    public Map<String, Object> payosWebhook(@RequestBody(required = false) PayosModels.WebhookBody webhookBody) {
        // Signature/malformed checks live in PayosClient/BillingService (400).
        // Do not reject PayOS sample payloads via bean validation before verify.
        billingService.handlePayosWebhook(webhookBody);
        return Map.of("ok", true);
    }

    private static UserPrincipal requirePrincipal(Authentication authentication) {
        if (authentication == null || !(authentication.getPrincipal() instanceof UserPrincipal principal)) {
            throw new ResponseStatusException(HttpStatus.UNAUTHORIZED, "Unauthorized");
        }
        return principal;
    }

    private static Map<String, Object> invoicePayload(BillingInvoice invoice) {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("orderCode", invoice.getOrderCode());
        payload.put("status", invoice.getStatus());
        payload.put("amountVnd", invoice.getAmountVnd());
        if (invoice.getPaidAt() != null) {
            payload.put("paidAt", invoice.getPaidAt());
        }
        if (invoice.getCheckoutUrl() != null) {
            payload.put("checkoutUrl", invoice.getCheckoutUrl());
        }
        payload.put("planCode", invoice.getPlanCode());
        return payload;
    }

    private static long priceForPlan(List<Map<String, Object>> plans, String code) {
        return plans.stream()
                .filter(plan -> code.equalsIgnoreCase(String.valueOf(plan.get("code"))))
                .map(plan -> plan.get("priceVnd"))
                .filter(Number.class::isInstance)
                .map(Number.class::cast)
                .mapToLong(Number::longValue)
                .findFirst()
                .orElse(0L);
    }
}
