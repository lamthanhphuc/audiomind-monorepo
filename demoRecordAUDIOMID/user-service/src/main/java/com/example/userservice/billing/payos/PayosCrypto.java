package com.example.userservice.billing.payos;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class PayosCrypto {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();

    private PayosCrypto() {
    }

    public static String createSignatureFromObject(Map<String, Object> data, String checksumKey) {
        if (data == null) {
            throw new IllegalArgumentException("data must not be null");
        }
        if (checksumKey == null || checksumKey.isBlank()) {
            throw new IllegalArgumentException("checksumKey must not be blank");
        }

        Map<String, Object> sorted = deepSortObject(data, false);
        String queryString = toQueryString(sorted);
        return hmacSha256Hex(checksumKey, queryString);
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> deepSortObject(Map<String, Object> input, boolean sortArrays) {
        List<String> keys = new ArrayList<>(input.keySet());
        keys.sort(Comparator.naturalOrder());
        Map<String, Object> out = new LinkedHashMap<>();
        for (String key : keys) {
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
            String key = entry.getKey();
            Object value = entry.getValue();
            String valueString;
            if (value == null) {
                valueString = "";
            } else if (value instanceof List<?> || value instanceof Map<?, ?>) {
                try {
                    valueString = OBJECT_MAPPER.writeValueAsString(value);
                } catch (JsonProcessingException e) {
                    throw new IllegalArgumentException("Unable to serialize nested value for signing", e);
                }
            } else {
                valueString = String.valueOf(value);
            }

            if (!first) {
                sb.append('&');
            }
            first = false;
            sb.append(urlEncode(key)).append('=').append(urlEncode(valueString));
        }
        return sb.toString();
    }

    private static String urlEncode(String value) {
        return URLEncoder.encode(value == null ? "" : value, StandardCharsets.UTF_8);
    }

    private static String hmacSha256Hex(String secret, String payload) {
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

