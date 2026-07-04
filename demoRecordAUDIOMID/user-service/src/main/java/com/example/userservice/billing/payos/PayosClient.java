package com.example.userservice.billing.payos;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.HashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Component;
import org.springframework.util.StringUtils;
import org.springframework.web.client.RestTemplate;

@Component
public class PayosClient {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private final RestTemplate restTemplate;

    @Value("${payos.enabled:false}")
    private boolean enabled;

    @Value("${payos.base-url:https://api-merchant.payos.vn}")
    private String baseUrl;

    @Value("${payos.client-id:}")
    private String clientId;

    @Value("${payos.api-key:}")
    private String apiKey;

    @Value("${payos.checksum-key:}")
    private String checksumKey;

    @Value("${payos.return-url:}")
    private String returnUrl;

    @Value("${payos.cancel-url:}")
    private String cancelUrl;

    public PayosClient(RestTemplate restTemplate) {
        this.restTemplate = restTemplate;
    }

    public boolean isEnabled() {
        return enabled
                && StringUtils.hasText(clientId)
                && StringUtils.hasText(apiKey)
                && StringUtils.hasText(checksumKey);
    }

    public PayosPaymentInfo getPaymentRequest(long orderCode) {
        if (!enabled) {
            throw new IllegalStateException("PayOS is disabled");
        }
        if (!StringUtils.hasText(clientId) || !StringUtils.hasText(apiKey) || !StringUtils.hasText(checksumKey)) {
            throw new IllegalStateException("PayOS config missing");
        }

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("x-client-id", clientId);
        headers.add("x-api-key", apiKey);

        ResponseEntity<PayosModels.CreatePaymentLinkResponse> response = restTemplate.exchange(
                normalizeBaseUrl(baseUrl) + "/v2/payment-requests/" + orderCode,
                HttpMethod.GET,
                new HttpEntity<>(headers),
                PayosModels.CreatePaymentLinkResponse.class
        );

        PayosModels.CreatePaymentLinkResponse body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("PayOS empty response");
        }
        if (!"00".equals(body.code())) {
            throw new IllegalStateException("PayOS error: " + body.desc());
        }
        if (body.data() == null || body.signature() == null) {
            throw new IllegalStateException("PayOS invalid response body");
        }
        if (!PayosCrypto.verifyPaymentResponseSignature(body.data(), body.signature(), checksumKey)) {
            throw new IllegalStateException("PayOS response signature mismatch");
        }

        String status = stringField(body.data(), "status");
        long amount = parseLongField(body.data(), "amount");
        long amountPaid = parseLongField(body.data(), "amountPaid");
        return new PayosPaymentInfo(status, amount, amountPaid);
    }

    public PayosCreateResult createPaymentLink(long orderCode, long amountVnd, String description) {
        if (!enabled) {
            throw new IllegalStateException("PayOS is disabled");
        }
        if (!StringUtils.hasText(clientId) || !StringUtils.hasText(apiKey) || !StringUtils.hasText(checksumKey)) {
            throw new IllegalStateException("PayOS config missing");
        }

        // Sign only the five payment-request fields (raw scalars). signature is attached after.
        Map<String, Object> signedFields = new HashMap<>();
        signedFields.put("orderCode", orderCode);
        signedFields.put("amount", amountVnd);
        signedFields.put("description", description);
        signedFields.put("cancelUrl", cancelUrl);
        signedFields.put("returnUrl", appendOrderCode(returnUrl, orderCode));

        String signature = PayosCrypto.createPaymentRequestSignature(signedFields, checksumKey);
        Map<String, Object> payload = new HashMap<>(signedFields);
        payload.put("signature", signature);

        HttpHeaders headers = new HttpHeaders();
        headers.setContentType(MediaType.APPLICATION_JSON);
        headers.add("x-client-id", clientId);
        headers.add("x-api-key", apiKey);

        ResponseEntity<PayosModels.CreatePaymentLinkResponse> response = restTemplate.exchange(
                normalizeBaseUrl(baseUrl) + "/v2/payment-requests",
                HttpMethod.POST,
                new HttpEntity<>(payload, headers),
                PayosModels.CreatePaymentLinkResponse.class
        );

        PayosModels.CreatePaymentLinkResponse body = response.getBody();
        if (body == null) {
            throw new IllegalStateException("PayOS empty response");
        }
        if (!"00".equals(body.code())) {
            throw new IllegalStateException("PayOS error: " + body.desc());
        }

        if (body.data() == null || body.signature() == null) {
            throw new IllegalStateException("PayOS invalid response body");
        }
        if (!PayosCrypto.verifyPaymentResponseSignature(body.data(), body.signature(), checksumKey)) {
            throw new IllegalStateException("PayOS response signature mismatch");
        }

        String checkoutUrl = stringField(body.data(), "checkoutUrl");
        String paymentLinkId = stringField(body.data(), "paymentLinkId");
        String qrCode = stringField(body.data(), "qrCode");
        return new PayosCreateResult(paymentLinkId, checkoutUrl, qrCode);
    }

    public Map<String, Object> verifyWebhookAndExtractData(PayosModels.WebhookBody webhookBody) {
        if (!StringUtils.hasText(checksumKey)) {
            throw new IllegalStateException("PayOS checksum key missing");
        }
        if (webhookBody == null || webhookBody.data() == null || !StringUtils.hasText(webhookBody.signature())) {
            throw new IllegalArgumentException("Invalid webhook payload");
        }
        if (!PayosCrypto.verifyWebhookSignature(webhookBody.data(), webhookBody.signature(), checksumKey)) {
            throw new IllegalArgumentException("Webhook signature invalid");
        }
        return webhookBody.data();
    }

    private static String normalizeBaseUrl(String baseUrl) {
        if (baseUrl == null) {
            return "";
        }
        return baseUrl.endsWith("/") ? baseUrl.substring(0, baseUrl.length() - 1) : baseUrl;
    }

    private static String stringField(Map<String, Object> data, String key) {
        Object raw = data.get(key);
        return raw == null ? null : String.valueOf(raw);
    }

    static String appendOrderCode(String baseReturnUrl, long orderCode) {
        if (!StringUtils.hasText(baseReturnUrl)) {
            return baseReturnUrl;
        }
        String separator = baseReturnUrl.contains("?") ? "&" : "?";
        return baseReturnUrl + separator + "orderCode=" + orderCode;
    }

    private static long parseLongField(Map<String, Object> data, String key) {
        Object raw = data.get(key);
        if (raw instanceof Number num) {
            return num.longValue();
        }
        if (raw == null) {
            return 0L;
        }
        try {
            return Long.parseLong(String.valueOf(raw));
        } catch (NumberFormatException ex) {
            return 0L;
        }
    }

    public record PayosCreateResult(String paymentLinkId, String checkoutUrl, String qrCode) {
    }

    public record PayosPaymentInfo(String status, long amount, long amountPaid) {
    }
}
