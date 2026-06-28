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

    public PayosCreateResult createPaymentLink(long orderCode, long amountVnd, String description) {
        if (!enabled) {
            throw new IllegalStateException("PayOS is disabled");
        }
        if (!StringUtils.hasText(clientId) || !StringUtils.hasText(apiKey) || !StringUtils.hasText(checksumKey)) {
            throw new IllegalStateException("PayOS config missing");
        }

        Map<String, Object> payload = new HashMap<>();
        payload.put("orderCode", orderCode);
        payload.put("amount", amountVnd);
        payload.put("description", description);
        payload.put("cancelUrl", cancelUrl);
        payload.put("returnUrl", appendOrderCode(returnUrl, orderCode));

        String signature = PayosCrypto.createSignatureFromObject(payload, checksumKey);
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

        // Verify response body signature (signing the `data` object)
        if (body.data() == null || body.signature() == null) {
            throw new IllegalStateException("PayOS invalid response body");
        }
        String expected = PayosCrypto.createSignatureFromObject(body.data(), checksumKey);
        if (!expected.equals(body.signature())) {
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
        String expected = PayosCrypto.createSignatureFromObject(webhookBody.data(), checksumKey);
        if (!expected.equals(webhookBody.signature())) {
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

    public record PayosCreateResult(String paymentLinkId, String checkoutUrl, String qrCode) {
    }
}

