package com.example.userservice.client;

import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestTemplate;

@ExtendWith(MockitoExtension.class)
class PendingMeetingShareClientTest {

    @Mock
    private RestTemplate restTemplate;

    private PendingMeetingShareClient client;

    @BeforeEach
    void setUp() {
        client = new PendingMeetingShareClient(restTemplate);
        ReflectionTestUtils.setField(client, "meetingApiBaseUrl", "http://meeting-api:8081");
        ReflectionTestUtils.setField(client, "internalServiceToken", "");
    }

    @Test
    void acceptPendingInvites_skipsWhenInternalTokenMissing() {
        client.acceptPendingInvites(7L, "guest@example.com");

        verify(restTemplate, never()).postForEntity(any(String.class), any(), eq(java.util.Map.class));
    }

    @Test
    void acceptPendingInvites_postsWhenTokenConfigured() {
        ReflectionTestUtils.setField(client, "internalServiceToken", "secret-token");

        client.acceptPendingInvites(7L, "guest@example.com");

        verify(restTemplate).postForEntity(
                eq("http://meeting-api:8081/internal/meeting-shares/accept-pending"),
                any(),
                eq(java.util.Map.class));
    }
}
