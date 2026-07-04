package com.example.userservice.controller;

import com.example.userservice.billing.BillingService;
import com.example.userservice.billing.payos.PayosModels;
import com.example.userservice.entity.BillingInvoice;
import com.example.userservice.quota.QuotaService;
import com.example.userservice.security.UserPrincipal;
import jakarta.validation.Valid;
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

    @GetMapping("/me")
    public Map<String, Object> me(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        List<BillingInvoice> invoices = billingService.listMyInvoices(principal.userId());
        QuotaService.QuotaSnapshot quota = quotaService.snapshot(principal.userId());
        return Map.of(
                "userId", principal.userId(),
                "plan", quota.plan(),
                "jwtPlan", principal.plan(),
                "quota", quota,
                "invoices", invoices,
                "proPriceVnd", billingService.proPriceVnd(),
                "payosEnabled", billingService.payosEnabled()
        );
    }

    @PostMapping("/checkout/pro")
    public Map<String, Object> checkoutPro(Authentication authentication) {
        UserPrincipal principal = requirePrincipal(authentication);
        BillingInvoice invoice = billingService.createProCheckout(principal.userId());
        return Map.of(
                "orderCode", invoice.getOrderCode(),
                "checkoutUrl", invoice.getCheckoutUrl(),
                "paymentLinkId", invoice.getPaymentLinkId(),
                "status", invoice.getStatus(),
                "amountVnd", invoice.getAmountVnd()
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
    public Map<String, Object> payosWebhook(@Valid @RequestBody PayosModels.WebhookBody webhookBody) {
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
        return payload;
    }
}

