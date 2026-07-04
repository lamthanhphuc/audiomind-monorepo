package com.example.userservice.controller;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.example.userservice.knowledge.KnowledgeNoteService;
import com.example.userservice.security.UserPrincipal;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.security.core.Authentication;

class KnowledgeNoteControllerTest {

    @Test
    void listNotesForMeetingUsesAuthenticatedUser() {
        KnowledgeNoteService service = mock(KnowledgeNoteService.class);
        KnowledgeNoteController controller = new KnowledgeNoteController(service);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(4L, "user", "USER", "FREE"));
        when(service.listForMeeting(4L, 11L)).thenReturn(List.of(Map.of("id", 1L, "term", "API")));

        Map<String, Object> response = controller.list(authentication, null, 11L);

        assertEquals(1, ((List<?>) response.get("items")).size());
        verify(service).listForMeeting(4L, 11L);
    }

    @Test
    void createNoteDelegatesToService() {
        KnowledgeNoteService service = mock(KnowledgeNoteService.class);
        KnowledgeNoteController controller = new KnowledgeNoteController(service);
        Authentication authentication = mock(Authentication.class);
        when(authentication.getPrincipal()).thenReturn(new UserPrincipal(4L, "user", "USER", "FREE"));
        Map<String, Object> body = Map.of("body", "Important note", "term", "API");
        when(service.create(eq(4L), eq(body))).thenReturn(Map.of("id", 9L, "body", "Important note"));

        Map<String, Object> response = controller.create(authentication, body);

        assertEquals(9L, response.get("id"));
        verify(service).create(4L, body);
    }
}
