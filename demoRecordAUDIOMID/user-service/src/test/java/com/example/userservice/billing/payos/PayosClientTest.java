package com.example.userservice.billing.payos;

import static org.junit.jupiter.api.Assertions.assertEquals;

import org.junit.jupiter.api.Test;

class PayosClientTest {

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
}
