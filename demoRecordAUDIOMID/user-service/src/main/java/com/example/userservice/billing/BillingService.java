package com.example.userservice.billing;

import com.example.userservice.billing.payos.PayosClient;
import com.example.userservice.billing.payos.PayosModels;
import com.example.userservice.entity.BillingInvoice;
import com.example.userservice.entity.BillingWebhookEvent;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.repository.BillingInvoiceRepository;
import com.example.userservice.repository.BillingWebhookEventRepository;
import com.example.userservice.repository.UserAccountRepository;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ThreadLocalRandom;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.util.StringUtils;

@Service
@RequiredArgsConstructor
@Slf4j
public class BillingService {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final PayosClient payosClient;
    private final BillingInvoiceRepository invoiceRepository;
    private final BillingWebhookEventRepository webhookEventRepository;
    private final UserAccountRepository userAccountRepository;

    @Transactional
    public BillingInvoice createProCheckout(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));

        long amountVnd = 99000; // MVP: fixed Pro price
        long orderCode = generateOrderCode();
        String description = "Audiomind PRO subscription";

        PayosClient.PayosCreateResult payos = payosClient.createPaymentLink(orderCode, amountVnd, description);

        BillingInvoice invoice = new BillingInvoice();
        invoice.setUserId(user.getId());
        invoice.setProvider("PAYOS");
        invoice.setOrderCode(orderCode);
        invoice.setAmountVnd(amountVnd);
        invoice.setCurrency("VND");
        invoice.setStatus("PENDING");
        invoice.setDescription(description);
        invoice.setPaymentLinkId(payos.paymentLinkId());
        invoice.setCheckoutUrl(payos.checkoutUrl());
        invoice.setQrCode(payos.qrCode());
        invoice.setCreatedAt(Instant.now());
        invoice.setUpdatedAt(Instant.now());
        return invoiceRepository.save(invoice);
    }

    @Transactional(readOnly = true)
    public List<BillingInvoice> listMyInvoices(Long userId) {
        return invoiceRepository.findTop50ByUserIdOrderByCreatedAtDesc(userId);
    }

    @Transactional(readOnly = true)
    public BillingInvoice getInvoiceForUser(Long userId, long orderCode) {
        BillingInvoice invoice = invoiceRepository.findByOrderCode(orderCode)
                .orElseThrow(() -> new java.util.NoSuchElementException("Invoice not found"));
        if (!invoice.getUserId().equals(userId)) {
            throw new org.springframework.security.access.AccessDeniedException("Forbidden");
        }
        return invoice;
    }

    @Transactional
    public void handlePayosWebhook(PayosModels.WebhookBody webhookBody) {
        Map<String, Object> data = payosClient.verifyWebhookAndExtractData(webhookBody);
        Long orderCode = parseLong(data.get("orderCode"));
        Long amount = parseLong(data.get("amount"));
        String paymentLinkId = data.get("paymentLinkId") == null ? null : String.valueOf(data.get("paymentLinkId"));
        String txCode = data.get("code") == null ? null : String.valueOf(data.get("code"));
        String txDesc = data.get("desc") == null ? null : String.valueOf(data.get("desc"));
        String signature = webhookBody.signature();

        if (StringUtils.hasText(signature)
                && webhookEventRepository.existsByProviderAndSignature("PAYOS", signature)) {
            log.info(
                    "event=PAYOS_WEBHOOK_DUPLICATE_SKIPPED orderCode={} signaturePresent=true",
                    orderCode
            );
            return;
        }

        BillingWebhookEvent evt = new BillingWebhookEvent();
        evt.setProvider("PAYOS");
        evt.setOrderCode(orderCode);
        evt.setPaymentLinkId(paymentLinkId);
        evt.setEventCode(webhookBody.code());
        evt.setEventDesc(webhookBody.desc());
        evt.setSuccess(webhookBody.success());
        evt.setSignature(signature);
        evt.setPayloadJson(serializeSafe(webhookBody));
        webhookEventRepository.save(evt);

        if (orderCode == null) {
            return;
        }
        Optional<BillingInvoice> invoiceOpt = invoiceRepository.findByOrderCode(orderCode);
        if (invoiceOpt.isEmpty()) {
            return;
        }

        BillingInvoice invoice = invoiceOpt.get();
        invoice.setUpdatedAt(Instant.now());
        if (StringUtils.hasText(paymentLinkId)) {
            invoice.setPaymentLinkId(paymentLinkId);
        }

        // PayOS success criteria (MVP):
        // - webhookBody.success == true
        // - data.code == "00" indicates payment success
        if (Boolean.TRUE.equals(webhookBody.success()) && "00".equals(txCode)) {
            if (!"PAID".equalsIgnoreCase(invoice.getStatus())) {
                markInvoicePaid(invoice, "payos_webhook");
                upgradeUserToPro(invoice.getUserId());
            }
        }

        invoiceRepository.save(invoice);
    }

    @Transactional
    public void adminMarkPaid(long orderCode, String note) {
        BillingInvoice invoice = invoiceRepository.findByOrderCode(orderCode)
                .orElseThrow(() -> new IllegalArgumentException("Invoice not found"));
        markInvoicePaid(invoice, "manual_admin");
        invoice.setManualNote(note);
        invoiceRepository.save(invoice);
        upgradeUserToPro(invoice.getUserId());
    }

    private void markInvoicePaid(BillingInvoice invoice, String source) {
        if ("PAID".equalsIgnoreCase(invoice.getStatus())) {
            return;
        }
        invoice.setStatus("PAID");
        invoice.setPaidAt(Instant.now());
        invoice.setManualNote(source);
    }

    private void upgradeUserToPro(Long userId) {
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        user.setPlan("PRO");
        userAccountRepository.save(user);
    }

    private static long generateOrderCode() {
        long now = System.currentTimeMillis();
        long rand = ThreadLocalRandom.current().nextInt(100, 999);
        return now * 1000L + rand;
    }

    private static Long parseLong(Object value) {
        if (value == null) {
            return null;
        }
        if (value instanceof Number num) {
            return num.longValue();
        }
        try {
            return Long.parseLong(String.valueOf(value));
        } catch (NumberFormatException ex) {
            return null;
        }
    }

    private static String serializeSafe(Object value) {
        try {
            return OBJECT_MAPPER.writeValueAsString(value);
        } catch (Exception e) {
            return "{}";
        }
    }
}

