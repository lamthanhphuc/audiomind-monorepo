package com.example.meetingservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.meetingservice.security.UserPrincipal;
import com.example.meetingservice.service.MeetingTaskService;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.Authentication;

class MeetingTaskControllerTest {

    @Test
    void listTasksUsesAuthenticatedUser() {
        MeetingTaskService service = mock(MeetingTaskService.class);
        MeetingTaskController controller = new MeetingTaskController(service);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(9L, "user", "USER", "FREE"));
        when(service.listTasks(21L, 9L)).thenReturn(List.of(Map.of("id", 1L, "title", "Follow up")));

        Map<String, Object> response = controller.list(21L, authentication);

        assertEquals(21L, response.get("meetingId"));
        verify(service).listTasks(21L, 9L);
    }

    @Test
    void createTaskDelegatesToService() {
        MeetingTaskService service = mock(MeetingTaskService.class);
        MeetingTaskController controller = new MeetingTaskController(service);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(2L, "user", "USER", "FREE"));
        Map<String, Object> body = Map.of("title", "Ship API");
        when(service.createTask(8L, 2L, body)).thenReturn(Map.of("id", 4L, "title", "Ship API"));

        Map<String, Object> response = controller.create(8L, body, authentication);

        assertEquals("Ship API", response.get("title"));
        verify(service).createTask(8L, 2L, body);
    }
}
