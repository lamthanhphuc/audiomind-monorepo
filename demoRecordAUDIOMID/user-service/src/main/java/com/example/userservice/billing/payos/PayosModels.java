package com.example.userservice.billing.payos;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;
import java.util.List;
import java.util.Map;

public final class PayosModels {

    private PayosModels() {
    }

    public record CreatePaymentLinkRequest(
            @JsonProperty("orderCode") long orderCode,
            @JsonProperty("amount") long amount,
            @JsonProperty("description") String description,
            @JsonProperty("cancelUrl") String cancelUrl,
            @JsonProperty("returnUrl") String returnUrl,
            @JsonProperty("signature") String signature,
            @JsonProperty("items") List<Map<String, Object>> items
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record CreatePaymentLinkResponse(
            @JsonProperty("code") String code,
            @JsonProperty("desc") String desc,
            @JsonProperty("data") Map<String, Object> data,
            @JsonProperty("signature") String signature
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record WebhookBody(
            @JsonProperty("code") String code,
            @JsonProperty("desc") String desc,
            @JsonProperty("success") Boolean success,
            @JsonProperty("data") Map<String, Object> data,
            @JsonProperty("signature") String signature
    ) {
    }
}

