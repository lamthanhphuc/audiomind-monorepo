package com.example.userservice.billing.payos;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class PayosCryptoTest {

    private static final String CHECKSUM_KEY = "test_checksum_key_0123456789abcdef";

    private static final String PAYMENT_REQUEST_CANONICAL =
            "amount=2000&cancelUrl=https://example.com/cancel&description=Audiomind"
                    + "&orderCode=123456&returnUrl=https://example.com/success?orderCode=123456";

    private static final String PAYMENT_REQUEST_SIGNATURE =
            "f62cb440e35710e9d12481b5a780886519dceee887a96ada3c518261ca9ad0ab";

    @Test
    void createPaymentRequestSignature_usesAlphabeticalRawValuesWithoutEncodingUrls() {
        Map<String, Object> payload = paymentRequestPayload();

        assertEquals(PAYMENT_REQUEST_CANONICAL, PayosCrypto.buildPaymentRequestCanonicalString(payload));
        assertFalse(PAYMENT_REQUEST_CANONICAL.contains("%3A"));
        assertFalse(PAYMENT_REQUEST_CANONICAL.contains("%2F"));
        assertFalse(PAYMENT_REQUEST_CANONICAL.contains("%20"));
        assertFalse(PAYMENT_REQUEST_CANONICAL.contains("+"));

        String signature = PayosCrypto.createPaymentRequestSignature(payload, CHECKSUM_KEY);
        assertEquals(PAYMENT_REQUEST_SIGNATURE, signature);
        assertEquals(hmacSha256Hex(CHECKSUM_KEY, PAYMENT_REQUEST_CANONICAL), signature);
    }

    @Test
    void createPaymentRequestSignature_ignoresSignatureField() {
        Map<String, Object> payload = paymentRequestPayload();
        payload.put("signature", "must-not-be-signed");
        payload.put("buyerName", "ignored-extra-field");

        assertEquals(
                PAYMENT_REQUEST_SIGNATURE,
                PayosCrypto.createPaymentRequestSignature(payload, CHECKSUM_KEY)
        );
    }

    @Test
    void createPaymentResponseSignature_usesRawObjectCanonicalization() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("status", "PAID");
        data.put("amount", 2000L);
        data.put("orderCode", 1L);
        data.put("checkoutUrl", "https://pay.payos.vn/web/abc");
        data.put("signature", "ignored");

        String canonical = PayosCrypto.buildPaymentObjectCanonicalString(data);
        assertEquals(
                "amount=2000&checkoutUrl=https://pay.payos.vn/web/abc&orderCode=1&status=PAID",
                canonical
        );
        assertFalse(canonical.contains("signature="));
        assertNoPercentOrFormEncoding(canonical);
    }

    @Test
    void createWebhookSignature_usesRawPaymentRequestsValuesForSpacesVietnameseAndUrls() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("orderCode", 99L);
        data.put("amount", 2000);
        data.put("desc", "Thành công");
        data.put("description", "thanh toan don hang");
        data.put("counterAccountName", "NGUYEN VAN A");
        data.put("checkoutHint", "https://example.com/path?x=1&y=2");
        data.put("signature", "ignored");

        String canonical = PayosCrypto.buildPaymentObjectCanonicalString(data);
        assertTrue(canonical.contains("counterAccountName=NGUYEN VAN A"));
        assertTrue(canonical.contains("desc=Thành công"));
        assertTrue(canonical.contains("checkoutHint=https://example.com/path?x=1&y=2"));
        assertFalse(canonical.contains("signature="));
        assertNoPercentOrFormEncoding(canonical);

        String signature = PayosCrypto.createWebhookSignature(data, CHECKSUM_KEY);
        assertEquals(hmacSha256Hex(CHECKSUM_KEY, canonical), signature);
        assertTrue(PayosCrypto.verifyWebhookSignature(data, signature, CHECKSUM_KEY));

        // Payment webhook and payment response share payment-requests object canonicalization.
        assertEquals(
                PayosCrypto.createPaymentResponseSignature(data, CHECKSUM_KEY),
                PayosCrypto.createWebhookSignature(data, CHECKSUM_KEY)
        );
    }

    @Test
    void createWebhookSignature_nullBecomesEmptyAndNestedObjectsArraysAreSupported() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("b", 2);
        nested.put("a", 1);

        List<Map<String, Object>> items = new ArrayList<>();
        Map<String, Object> first = new LinkedHashMap<>();
        first.put("name", "second-item");
        first.put("qty", 1);
        Map<String, Object> second = new LinkedHashMap<>();
        second.put("name", "first-item");
        second.put("qty", 2);
        items.add(first);
        items.add(second);

        Map<String, Object> data = new LinkedHashMap<>();
        data.put("orderCode", 1L);
        data.put("optionalField", null);
        data.put("meta", nested);
        data.put("items", items);

        String canonical = PayosCrypto.buildPaymentObjectCanonicalString(data);
        assertTrue(canonical.contains("optionalField="));
        assertTrue(canonical.contains("items="));
        assertTrue(canonical.indexOf("second-item") < canonical.indexOf("first-item"));
        assertTrue(canonical.contains("{\"a\":1,\"b\":2}"));
        assertNoPercentOrFormEncoding(canonical);
    }

    private static void assertNoPercentOrFormEncoding(String canonical) {
        assertFalse(canonical.contains("+"), "must not use form-encoding '+'");
        assertFalse(canonical.contains("%20"), "must not percent-encode spaces");
        assertFalse(canonical.contains("%2F"), "must not percent-encode '/'");
        assertFalse(canonical.contains("%2f"));
        assertFalse(canonical.contains("%3A"));
        assertFalse(canonical.contains("%3a"));
    }

    private static Map<String, Object> paymentRequestPayload() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("returnUrl", "https://example.com/success?orderCode=123456");
        payload.put("orderCode", 123456L);
        payload.put("description", "Audiomind");
        payload.put("amount", 2000L);
        payload.put("cancelUrl", "https://example.com/cancel");
        return payload;
    }

    private static String hmacSha256Hex(String secret, String payload) {
        try {
            javax.crypto.Mac mac = javax.crypto.Mac.getInstance("HmacSHA256");
            mac.init(new javax.crypto.spec.SecretKeySpec(
                    secret.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    "HmacSHA256"
            ));
            byte[] out = mac.doFinal(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            StringBuilder sb = new StringBuilder(out.length * 2);
            for (byte b : out) {
                sb.append(String.format("%02x", b));
            }
            return sb.toString();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
