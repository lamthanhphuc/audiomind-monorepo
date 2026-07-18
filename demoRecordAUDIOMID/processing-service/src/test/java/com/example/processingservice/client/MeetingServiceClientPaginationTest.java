package com.example.processingservice.client;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.ArgumentMatchers.contains;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import java.util.List;
import java.util.Map;

import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.ArgumentCaptor;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.core.ParameterizedTypeReference;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.web.client.RestTemplate;

@ExtendWith(MockitoExtension.class)
class MeetingServiceClientPaginationTest {

    @Mock
    private RestTemplate restTemplate;

    private MeetingServiceClient client;

    @BeforeEach
    void setUp() {
        client = new MeetingServiceClient(restTemplate);
        ReflectionTestUtils.setField(client, "meetingServiceUrl", "http://meeting");
    }

    @Test
    void listAllSubjectMeetings_fetchesAllPages() {
        when(restTemplate.exchange(
                contains("page=1"),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(ParameterizedTypeReference.class)
        )).thenReturn(ResponseEntity.ok(Map.of(
                "items", List.of(Map.of("id", 1L), Map.of("id", 2L)),
                "totalPages", 2
        )));
        when(restTemplate.exchange(
                contains("page=2"),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(ParameterizedTypeReference.class)
        )).thenReturn(ResponseEntity.ok(Map.of(
                "items", List.of(Map.of("id", 3L)),
                "totalPages", 2
        )));

        List<Map<String, Object>> all = client.listAllSubjectMeetings(12L, "trace", "Bearer t");
        assertEquals(3, all.size());
        assertEquals(1L, ((Number) all.get(0).get("id")).longValue());
        assertEquals(3L, ((Number) all.get(2).get("id")).longValue());

        ArgumentCaptor<String> urlCaptor = ArgumentCaptor.forClass(String.class);
        verify(restTemplate, times(2)).exchange(
                urlCaptor.capture(),
                eq(HttpMethod.GET),
                any(HttpEntity.class),
                any(ParameterizedTypeReference.class)
        );
        assertEquals(2, urlCaptor.getAllValues().size());
    }
}
