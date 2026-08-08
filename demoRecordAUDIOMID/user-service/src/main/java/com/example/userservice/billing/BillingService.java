package com.example.userservice.billing;

import com.example.userservice.billing.payos.PayosClient;
import com.example.userservice.billing.payos.PayosModels;
import com.example.userservice.entity.BillingInvoice;
import com.example.userservice.entity.BillingWebhookEvent;
import com.example.userservice.entity.UserAccount;
import com.example.userservice.entity.SubscriptionPlan;
import com.example.userservice.plan.SubscriptionPlanService;
import com.example.userservice.repository.BillingInvoiceRepository;
import com.example.userservice.repository.BillingWebhookEventRepository;
import com.example.userservice.plan.UserPlanService;
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
    private final UserPlanService userPlanService;
    private final SubscriptionPlanService subscriptionPlanService;

    public boolean payosEnabled() {
        return payosClient.isEnabled();
    }

    @Transactional
    public BillingInvoice createProCheckout(Long userId) {
        return createCheckout(userId, UserPlanService.PLAN_STANDARD);
    }

    @Transactional
    public BillingInvoice createStudentCheckout(Long userId) {
        return createCheckout(userId, UserPlanService.PLAN_STANDARD);
    }

    @Transactional
    public BillingInvoice createCheckout(Long userId, String targetPlan) {
        targetPlan = UserPlanService.normalizePlanOrFree(SubscriptionPlanService.normalizeCode(targetPlan));
        UserAccount user = userAccountRepository.findById(userId)
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        userPlanService.refreshExpiredPlan(user);
        String currentPlan = userPlanService.resolveEffectivePlan(user);
        if (currentPlan.equalsIgnoreCase(targetPlan) && user.getPlanExpiresAt() == null) {
            throw new IllegalArgumentException("Tài khoản đã là gói " + targetPlan);
        }
        SubscriptionPlan plan = subscriptionPlanService.requireActiveByCode(targetPlan);
        long amountVnd = plan.getPriceVnd();
        long orderCode = generateOrderCode();
        // PayOS giới hạn mô tả ngắn (9 ký tự với một số kênh thanh toán).
        String description = "Audiomind";

        PayosClient.PayosCreateResult payos = payosClient.createPaymentLink(orderCode, amountVnd, description);

        BillingInvoice invoice = new BillingInvoice();
        invoice.setUserId(user.getId());
        invoice.setProvider("PAYOS");
        invoice.setOrderCode(orderCode);
        invoice.setAmountVnd(amountVnd);
        invoice.setPlanCode(plan.getCode());
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

    @Transactional
    public BillingInvoice syncProPayment(Long userId, long orderCode) {
        BillingInvoice invoice = getInvoiceForUser(userId, orderCode);
        if ("PAID".equalsIgnoreCase(invoice.getStatus())) {
            return invoice;
        }

        PayosClient.PayosPaymentInfo payment = payosClient.getPaymentRequest(orderCode);
        if (isPayosPaymentSettled(payment, invoice.getAmountVnd())) {
            markInvoicePaid(invoice, "payos_sync");
            activateInvoicePlan(invoice);
            invoice.setUpdatedAt(Instant.now());
            invoiceRepository.save(invoice);
            log.info(
                    "event=PAYOS_PAYMENT_SYNCED orderCode={} userId={} status={} amountPaid={}",
                    orderCode,
                    userId,
                    payment.status(),
                    payment.amountPaid()
            );
        }
        return invoice;
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
            log.warn("event=PAYOS_WEBHOOK_UNKNOWN_ORDER orderCodeMissing=true paymentLinkIdPresent={}",
                    StringUtils.hasText(paymentLinkId));
            return;
        }
        Optional<BillingInvoice> invoiceOpt = invoiceRepository.findByOrderCode(orderCode);
        if (invoiceOpt.isEmpty()) {
            // PayOS dashboard sample / test webhooks must ACK 2xx without mutating billing state.
            log.warn(
                    "event=PAYOS_WEBHOOK_UNKNOWN_ORDER orderCode={} paymentLinkIdPresent={} amountPresent={}",
                    orderCode,
                    StringUtils.hasText(paymentLinkId),
                    amount != null
            );
            return;
        }

        BillingInvoice invoice = invoiceOpt.get();
        invoice.setUpdatedAt(Instant.now());
        if (StringUtils.hasText(paymentLinkId)) {
            invoice.setPaymentLinkId(paymentLinkId);
        }

        // Pay only when webhook is successful and amount matches the known invoice.
        boolean paymentSucceeded = Boolean.TRUE.equals(webhookBody.success()) && "00".equals(txCode);
        boolean amountMatches = amount != null && amount == invoice.getAmountVnd();
        if (paymentSucceeded && amountMatches) {
            if (!"PAID".equalsIgnoreCase(invoice.getStatus())) {
                markInvoicePaid(invoice, "payos_webhook");
                activateInvoicePlan(invoice);
            }
        } else if (paymentSucceeded) {
            log.warn(
                    "event=PAYOS_WEBHOOK_AMOUNT_MISMATCH orderCode={} expectedAmount={} payloadAmount={} txDescPresent={}",
                    orderCode,
                    invoice.getAmountVnd(),
                    amount,
                    StringUtils.hasText(txDesc)
            );
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
        activateInvoicePlan(invoice);
    }

    private void markInvoicePaid(BillingInvoice invoice, String source) {
        if ("PAID".equalsIgnoreCase(invoice.getStatus())) {
            return;
        }
        invoice.setStatus("PAID");
        invoice.setPaidAt(Instant.now());
        invoice.setManualNote(source);
    }

    private void activateInvoicePlan(BillingInvoice invoice) {
        UserAccount user = userAccountRepository.findById(invoice.getUserId())
                .orElseThrow(() -> new IllegalArgumentException("User not found"));
        String targetPlan = UserPlanService.normalizePlanOrFree(
                SubscriptionPlanService.normalizeCode(invoice.getPlanCode()));
        user.setPlan(targetPlan);
        user.setPlanExpiresAt(null);
        userAccountRepository.save(user);
    }

    private static boolean isPayosPaymentSettled(PayosClient.PayosPaymentInfo payment, long expectedAmountVnd) {
        if (payment == null) {
            return false;
        }
        if ("PAID".equalsIgnoreCase(payment.status())) {
            return true;
        }
        return payment.amountPaid() >= expectedAmountVnd && expectedAmountVnd > 0;
    }

    private static long generateOrderCode() {
        long epochSec = System.currentTimeMillis() / 1000L;
        long rand = ThreadLocalRandom.current().nextInt(100, 999);
        return epochSec * 1000L + rand;
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
