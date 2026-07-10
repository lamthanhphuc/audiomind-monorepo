package com.example.userservice.controller;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.example.userservice.billing.BillingService;
import com.example.userservice.billing.payos.PayosCrypto;
import com.example.userservice.billing.payos.PayosModels;
import com.example.userservice.plan.UserPlanService;
import com.example.userservice.quota.QuotaService;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

@ExtendWith(MockitoExtension.class)
class BillingControllerWebhookTest {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper();
    private static final String CHECKSUM_KEY = "test_checksum_key_0123456789abcdef";

    @Mock
    private BillingService billingService;

    @Mock
    private QuotaService quotaService;

    @Mock
    private UserPlanService userPlanService;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        BillingController controller = new BillingController(billingService, quotaService, userPlanService);
        mockMvc = MockMvcBuilders.standaloneSetup(controller)
                .setControllerAdvice(new GlobalExceptionHandler())
                .build();
    }

    @Test
    void payosWebhook_invalidSignature_returns400() throws Exception {
        doThrow(new IllegalArgumentException("Webhook signature invalid"))
                .when(billingService)
                .handlePayosWebhook(any(PayosModels.WebhookBody.class));

        Map<String, Object> body = webhookEnvelope(sampleData(1L), "deadbeef");

        mockMvc.perform(post("/api/billing/payos/webhook")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(OBJECT_MAPPER.writeValueAsString(body)))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.error").value("VALIDATION_ERROR"));
    }

    @Test
    void payosWebhook_malformedBody_returns400() throws Exception {
        doThrow(new IllegalArgumentException("Invalid webhook payload"))
                .when(billingService)
                .handlePayosWebhook(any());

        mockMvc.perform(post("/api/billing/payos/webhook")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content("{}"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void payosWebhook_validUnknownSample_returns200() throws Exception {
        Map<String, Object> data = sampleData(999999L);
        String signature = PayosCrypto.createWebhookSignature(data, CHECKSUM_KEY);
        Map<String, Object> body = webhookEnvelope(data, signature);

        mockMvc.perform(post("/api/billing/payos/webhook")
                        .contentType(MediaType.APPLICATION_JSON)
                        .content(OBJECT_MAPPER.writeValueAsString(body)))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.ok").value(true));

        verify(billingService).handlePayosWebhook(any(PayosModels.WebhookBody.class));
        verify(quotaService, never()).snapshot(any());
    }

    private static Map<String, Object> webhookEnvelope(Map<String, Object> data, String signature) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("code", "00");
        body.put("desc", "success");
        body.put("success", true);
        body.put("data", data);
        body.put("signature", signature);
        return body;
    }

    private static Map<String, Object> sampleData(long orderCode) {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("orderCode", orderCode);
        data.put("amount", 2000);
        data.put("description", "Audiomind");
        data.put("code", "00");
        data.put("desc", "Thành công");
        return data;
    }
}
