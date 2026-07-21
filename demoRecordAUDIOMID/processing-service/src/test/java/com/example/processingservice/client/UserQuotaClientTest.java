package com.example.processingservice.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.method;
import static org.springframework.test.web.client.match.MockRestRequestMatchers.requestTo;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withStatus;
import static org.springframework.test.web.client.response.MockRestResponseCreators.withSuccess;

import com.example.processingservice.client.UserQuotaClient.QuotaConsumeResult;
import com.example.processingservice.client.UserQuotaClient.QuotaConsumeStatus;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.client.ExpectedCount;
import org.springframework.test.web.client.MockRestServiceServer;
import org.springframework.web.client.ResourceAccessException;
import org.springframework.web.client.RestTemplate;

class UserQuotaClientTest {

    private static final String BASE = "http://user-api:8083";
    private static final String CONSUME_URL = BASE + "/internal/quota/consume";
    private static final String KEY = "study-artifact:42:quota";
    private static final String TYPE = "STUDY_ARTIFACT";

    private RestTemplate restTemplate;
    private MockRestServiceServer server;
    private UserQuotaClient client;

    @BeforeEach
    void setUp() {
        restTemplate = new RestTemplate();
        server = MockRestServiceServer.bindTo(restTemplate).build();
        client = new UserQuotaClient(restTemplate);
        ReflectionTestUtils.setField(client, "userApiBaseUrl", BASE);
        ReflectionTestUtils.setField(client, "internalServiceToken", "test-token");
        ReflectionTestUtils.setField(client, "quotaFailOpen", false);
    }

    @Test
    void http400_oneRequest_nonRetryableUnknown_requestInvalid() {
        expectHttpOnce(HttpStatus.BAD_REQUEST);

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, "QUOTA_REQUEST_INVALID", false);
        server.verify();
    }

    @Test
    void http401_oneRequest_unauthorized_noRetry() {
        expectHttpOnce(HttpStatus.UNAUTHORIZED);

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, "QUOTA_SERVICE_UNAUTHORIZED", false);
        server.verify();
    }

    @Test
    void http403_oneRequest_forbidden() {
        expectHttpOnce(HttpStatus.FORBIDDEN);

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, "QUOTA_SERVICE_FORBIDDEN", false);
        server.verify();
    }

    @Test
    void http404_oneRequest_endpointNotFound() {
        expectHttpOnce(HttpStatus.NOT_FOUND);

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, "QUOTA_ENDPOINT_NOT_FOUND", false);
        server.verify();
    }

    @Test
    void http429_retriesSameKey_upToThree() {
        expectHttpRetries(HttpStatus.TOO_MANY_REQUESTS, "QUOTA_HTTP_429");
    }

    @Test
    void http500_retriesSameKey_upToThree_unknownRetryable() {
        expectHttpRetries(HttpStatus.INTERNAL_SERVER_ERROR, "QUOTA_HTTP_500");
    }

    @Test
    void http501_retries() {
        expectHttpRetries(HttpStatus.NOT_IMPLEMENTED, "QUOTA_HTTP_501");
    }

    @Test
    void http502_retries() {
        expectHttpRetries(HttpStatus.BAD_GATEWAY, "QUOTA_HTTP_502");
    }

    @Test
    void http503_retries() {
        expectHttpRetries(HttpStatus.SERVICE_UNAVAILABLE, "QUOTA_HTTP_503");
    }

    @Test
    void http504_retries() {
        expectHttpRetries(HttpStatus.GATEWAY_TIMEOUT, "QUOTA_HTTP_504");
    }

    @Test
    void resourceAccessException_retries() {
        RestTemplate mockRt = mock(RestTemplate.class);
        UserQuotaClient retryClient = new UserQuotaClient(mockRt);
        ReflectionTestUtils.setField(retryClient, "userApiBaseUrl", BASE);
        ReflectionTestUtils.setField(retryClient, "internalServiceToken", "test-token");
        ReflectionTestUtils.setField(retryClient, "quotaFailOpen", false);

        when(mockRt.exchange(
                        eq(CONSUME_URL),
                        eq(HttpMethod.POST),
                        any(),
                        eq(java.util.Map.class)))
                .thenThrow(new ResourceAccessException("connect timed out"));

        QuotaConsumeResult result = retryClient.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, "QUOTA_TRANSPORT_ERROR", true);
        verify(mockRt, times(3)).exchange(
                eq(CONSUME_URL), eq(HttpMethod.POST), any(), eq(java.util.Map.class));
    }

    @Test
    void definitiveDenied_allowedFalse_noRetry() {
        server.expect(ExpectedCount.once(), requestTo(CONSUME_URL))
                .andExpect(method(HttpMethod.POST))
                .andRespond(withSuccess(
                        "{\"allowed\":false,\"status\":\"DENIED\"}", MediaType.APPLICATION_JSON));

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertEquals(QuotaConsumeStatus.DENIED, result.status());
        assertFalse(result.retryable());
        assertEquals("QUOTA_EXCEEDED", result.errorCode());
        server.verify();
    }

    @Test
    void definitiveDenied_statusDenied_noRetry() {
        server.expect(ExpectedCount.once(), requestTo(CONSUME_URL))
                .andExpect(method(HttpMethod.POST))
                .andRespond(withSuccess("{\"status\":\"DENIED\"}", MediaType.APPLICATION_JSON));

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertEquals(QuotaConsumeStatus.DENIED, result.status());
        assertNotEquals(QuotaConsumeStatus.UNKNOWN, result.status());
        server.verify();
    }

    @Test
    void unknownNeverBecomesDenied_onHttp400() {
        expectHttpOnce(HttpStatus.BAD_REQUEST);

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertEquals(QuotaConsumeStatus.UNKNOWN, result.status());
        assertNotEquals(QuotaConsumeStatus.DENIED, result.status());
        assertFalse(result.retryable());
        server.verify();
    }

    @Test
    void missingInternalToken_studyPath_nonRetryableUnconfigured() {
        ReflectionTestUtils.setField(client, "internalServiceToken", "");

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, "QUOTA_CLIENT_UNCONFIGURED", false);
    }

    private void expectHttpOnce(HttpStatus status) {
        server.expect(ExpectedCount.once(), requestTo(CONSUME_URL))
                .andExpect(method(HttpMethod.POST))
                .andRespond(withStatus(status));
    }

    private void expectHttpRetries(HttpStatus status, String errorCode) {
        server.expect(ExpectedCount.times(3), requestTo(CONSUME_URL))
                .andExpect(method(HttpMethod.POST))
                .andRespond(withStatus(status));

        QuotaConsumeResult result = client.consume(1L, 0, 100, KEY, TYPE);

        assertUnknown(result, errorCode, true);
        server.verify();
    }

    private static void assertUnknown(QuotaConsumeResult result, String errorCode, boolean retryable) {
        assertEquals(QuotaConsumeStatus.UNKNOWN, result.status());
        assertEquals(errorCode, result.errorCode());
        assertEquals(retryable, result.retryable());
        assertNotEquals(QuotaConsumeStatus.DENIED, result.status());
    }
}
