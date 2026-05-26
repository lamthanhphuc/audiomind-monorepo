package com.example.meetingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;

import com.example.meetingservice.repository.MeetingRepository;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;

class HealthControllerTest {

    @Test
    void health_shouldReturnUpPayload() {
        MeetingRepository meetingRepository = mock(MeetingRepository.class);
        HealthController controller = new HealthController(meetingRepository);

        Map<String, Object> response = controller.health();

        assertEquals("UP", response.get("status"));
        assertEquals("meeting-service", response.get("service"));
        assertEquals("ok", response.get("legacyStatus"));
        assertNotNull(response.get("timestamp"));
        assertEquals(Map.of(), response.get("dependencies"));
    }

    @Test
    void ready_shouldReturnUpWhenDatabaseIsReachable() {
        MeetingRepository meetingRepository = mock(MeetingRepository.class);
        when(meetingRepository.count()).thenReturn(1L);
        HealthController controller = new HealthController(meetingRepository);

        ResponseEntity<Map<String, Object>> response = controller.ready();

        assertEquals(HttpStatus.OK, response.getStatusCode());
        assertEquals("UP", response.getBody().get("status"));
        @SuppressWarnings("unchecked")
        Map<String, String> dependencies = (Map<String, String>) response.getBody().get("dependencies");
        assertEquals("UP", dependencies.get("database"));
    }

    @Test
    void ready_shouldReturnServiceUnavailableWhenDatabaseCheckFails() {
        MeetingRepository meetingRepository = mock(MeetingRepository.class);
        doThrow(new IllegalStateException("db down")).when(meetingRepository).count();
        HealthController controller = new HealthController(meetingRepository);

        ResponseEntity<Map<String, Object>> response = controller.ready();

        assertEquals(HttpStatus.SERVICE_UNAVAILABLE, response.getStatusCode());
        assertEquals("DOWN", response.getBody().get("status"));
        assertEquals("not_ready", response.getBody().get("legacyStatus"));
        @SuppressWarnings("unchecked")
        Map<String, String> dependencies = (Map<String, String>) response.getBody().get("dependencies");
        assertEquals("DOWN", dependencies.get("database"));
    }
}
