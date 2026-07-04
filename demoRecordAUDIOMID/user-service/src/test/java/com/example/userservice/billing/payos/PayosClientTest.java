package com.example.userservice.billing.payos;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestTemplate;

class PayosClientTest {

    private static final String CHECKSUM_KEY = "test_checksum_key_0123456789abcdef";

    private PayosClient payosClient;

    @BeforeEach
    void setUp() {
        payosClient = new PayosClient(new RestTemplate());
        ReflectionTestUtils.setField(payosClient, "checksumKey", CHECKSUM_KEY);
    }

    @Test
    void appendOrderCode_addsQueryParamToReturnUrl() {
        assertEquals(
                "http://localhost:8080/billing/success?orderCode=9001",
                PayosClient.appendOrderCode("http://localhost:8080/billing/success", 9001L)
        );
    }

    @Test
    void appendOrderCode_appendsWithAmpersandWhenQueryExists() {
        assertEquals(
                "http://localhost:8080/billing/success?foo=bar&orderCode=42",
                PayosClient.appendOrderCode("http://localhost:8080/billing/success?foo=bar", 42L)
        );
    }

    @Test
    void verifyWebhookAndExtractData_rejectsMissingPayload() {
        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class,
                () -> payosClient.verifyWebhookAndExtractData(null)
        );
        assertTrue(ex.getMessage().contains("Invalid webhook payload"));
    }

    @Test
    void verifyWebhookAndExtractData_rejectsInvalidSignature() {
        Map<String, Object> data = sampleWebhookData(123L);
        PayosModels.WebhookBody body = new PayosModels.WebhookBody(
                "00",
                "success",
                true,
                data,
                "deadbeef"
        );

        IllegalArgumentException ex = assertThrows(
                IllegalArgumentException.class,
                () -> payosClient.verifyWebhookAndExtractData(body)
        );
        assertTrue(ex.getMessage().contains("Webhook signature invalid"));
    }

    @Test
    void verifyWebhookAndExtractData_acceptsValidWebhookSignature() {
        Map<String, Object> data = sampleWebhookData(123L);
        String signature = PayosCrypto.createWebhookSignature(data, CHECKSUM_KEY);
        PayosModels.WebhookBody body = new PayosModels.WebhookBody(
                "00",
                "success",
                true,
                data,
                signature
        );

        Map<String, Object> extracted = payosClient.verifyWebhookAndExtractData(body);
        assertEquals(123L, extracted.get("orderCode"));
    }

    private static Map<String, Object> sampleWebhookData(long orderCode) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("orderCode", orderCode);
        data.put("amount", 2000);
        data.put("description", "Audiomind");
        data.put("accountNumber", "12345678");
        data.put("reference", "TF230204212323");
        data.put("transactionDateTime", "2023-02-04 18:25:00");
        data.put("currency", "VND");
        data.put("paymentLinkId", "124c33293c43417ab7879e14c8d9eb18");
        data.put("code", "00");
        data.put("desc", "Thành công");
        return data;
    }
}
