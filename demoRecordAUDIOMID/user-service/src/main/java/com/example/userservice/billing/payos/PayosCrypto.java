package com.example.userservice.billing.payos;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

/**
 * PayOS payment-requests signatures (not payouts).
 *
 * <ul>
 *   <li>Create payment link: only amount/cancelUrl/description/orderCode/returnUrl, raw scalars.</li>
 *   <li>Payment response and payment webhook: full {@code data} object, alphabetic keys, raw values.</li>
 * </ul>
 * Payout-specific encodeURI/deep-array encoding is intentionally not used here.
 */
public final class PayosCrypto {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final String SIGNATURE_FIELD = "signature";

    private PayosCrypto() {
    }

    /**
     * Create-payment-link request signature.
     * Canonical (raw scalars): {@code amount=&cancelUrl=&description=&orderCode=&returnUrl=}
     */
    public static String createPaymentRequestSignature(Map<String, Object> data, String checksumKey) {
        if (data == null) {
            throw new IllegalArgumentException("data must not be null");
        }
        Map<String, Object> fields = new LinkedHashMap<>();
        for (String key : List.of("amount", "cancelUrl", "description", "orderCode", "returnUrl")) {
            if (!data.containsKey(key)) {
                throw new IllegalArgumentException("payment request missing field: " + key);
            }
            fields.put(key, data.get(key));
        }
        return hmacSha256Hex(checksumKey, buildPaymentRequestCanonicalString(fields));
    }

    /**
     * Payment-request API response {@code data} signature (PayOS {@code createSignatureFromObj}).
     */
    public static String createPaymentResponseSignature(Map<String, Object> data, String checksumKey) {
        return hmacSha256Hex(checksumKey, buildPaymentObjectCanonicalString(data));
    }

    public static boolean verifyPaymentResponseSignature(
            Map<String, Object> data,
            String signature,
            String checksumKey
    ) {
        if (signature == null || signature.isBlank()) {
            return false;
        }
        return createPaymentResponseSignature(data, checksumKey).equals(signature);
    }

    /**
     * Payment webhook {@code data} signature — same payment-requests object canonicalization
     * as the payment response (raw values, no URL encoding / encodeURI).
     */
    public static String createWebhookSignature(Map<String, Object> data, String checksumKey) {
        return hmacSha256Hex(checksumKey, buildPaymentObjectCanonicalString(data));
    }

    public static boolean verifyWebhookSignature(
            Map<String, Object> data,
            String signature,
            String checksumKey
    ) {
        if (signature == null || signature.isBlank()) {
            return false;
        }
        return createWebhookSignature(data, checksumKey).equals(signature);
    }

    static String buildPaymentRequestCanonicalString(Map<String, Object> data) {
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (String key : List.of("amount", "cancelUrl", "description", "orderCode", "returnUrl")) {
            if (!first) {
                sb.append('&');
            }
            first = false;
            sb.append(key).append('=').append(rawScalar(data.get(key)));
        }
        return sb.toString();
    }

    /**
     * Alphabetic keys, skip {@code signature}, null-like values become {@code ""},
     * nested object keys deep-sorted, array order preserved, scalar values left raw.
     */
    static String buildPaymentObjectCanonicalString(Map<String, Object> data) {
        if (data == null) {
            throw new IllegalArgumentException("data must not be null");
        }
        return toQueryString(deepSortObject(data, false));
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> deepSortObject(Map<String, Object> input, boolean sortArrays) {
        List<String> keys = new ArrayList<>(input.keySet());
        keys.sort(Comparator.naturalOrder());
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : keys) {
            if (SIGNATURE_FIELD.equals(key)) {
                continue;
            }
            Object value = input.get(key);
            if (value instanceof Map<?, ?> mapVal) {
                out.put(key, deepSortObject((Map<String, Object>) mapVal, sortArrays));
                continue;
            }
            if (value instanceof List<?> listVal) {
                List<Object> mapped = new ArrayList<>(listVal.size());
                for (Object item : listVal) {
                    if (item instanceof Map<?, ?> itemMap) {
                        mapped.add(deepSortObject((Map<String, Object>) itemMap, sortArrays));
                    } else {
                        mapped.add(item);
                    }
                }
                if (sortArrays) {
                    mapped.sort(Comparator.comparing(o -> o == null ? "" : String.valueOf(o)));
                }
                out.put(key, mapped);
                continue;
            }
            out.put(key, value);
        }
        return out;
    }

    private static String toQueryString(Map<String, Object> data) {
        StringBuilder sb = new StringBuilder();
        boolean first = true;
        for (Map.Entry<String, Object> entry : data.entrySet()) {
            if (!first) {
                sb.append('&');
            }
            first = false;
            sb.append(entry.getKey()).append('=').append(normalizeQueryValue(entry.getValue()));
        }
        return sb.toString();
    }

    private static String normalizeQueryValue(Object value) {
        if (value == null) {
            return "";
        }
        if (value instanceof String str) {
            if ("null".equals(str) || "undefined".equals(str)) {
                return "";
            }
            return str;
        }
        if (value instanceof List<?> || value instanceof Map<?, ?>) {
            try {
                return OBJECT_MAPPER.writeValueAsString(value);
            } catch (JsonProcessingException e) {
                throw new IllegalArgumentException("Unable to serialize nested value for signing", e);
            }
        }
        return String.valueOf(value);
    }

    private static String rawScalar(Object value) {
        if (value == null) {
            return "";
        }
        return String.valueOf(value);
    }

    private static String hmacSha256Hex(String secret, String payload) {
        if (secret == null || secret.isBlank()) {
            throw new IllegalArgumentException("checksumKey must not be blank");
        }
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            byte[] out = mac.doFinal(payload.getBytes(StandardCharsets.UTF_8));
            return toHex(out);
        } catch (Exception e) {
            throw new IllegalStateException("Failed to compute HMAC SHA-256 signature", e);
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }
}
