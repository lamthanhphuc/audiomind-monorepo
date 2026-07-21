package com.example.meetingservice.controller;

import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

import com.example.meetingservice.config.Epic2FeatureFlags;
import com.example.meetingservice.controller.dto.PageResponse;
import com.example.meetingservice.controller.dto.SubjectMeetingResponse;
import com.example.meetingservice.service.SubjectService;
import java.time.LocalDateTime;
import java.util.List;
import java.util.NoSuchElementException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;
import org.springframework.test.util.ReflectionTestUtils;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;

/**
 * HTTP-layer coverage for {@link InternalSubjectController}: token auth, JSON field
 * names ({@code items}/{@code page}/{@code pageSize}/{@code total}/{@code totalPages}),
 * and wrong-owner 404 via {@link GlobalExceptionHandler}.
 */
@ExtendWith(MockitoExtension.class)
class InternalSubjectControllerIntegrationTest {

    private static final String TOKEN = "internal-secret";

    @Mock
    private SubjectService subjectService;

    private MockMvc mockMvc;

    @BeforeEach
    void setUp() {
        InternalSubjectController controller = new InternalSubjectController(subjectService);
        ReflectionTestUtils.setField(controller, "internalServiceToken", TOKEN);
        mockMvc = MockMvcBuilders.standaloneSetup(controller)
                .setControllerAdvice(new GlobalExceptionHandler(new Epic2FeatureFlags()))
                .build();
    }

    @Test
    void listMeetings_validToken_returns200WithPaginationFieldNames() throws Exception {
        SubjectMeetingResponse meeting = new SubjectMeetingResponse(
                100L, "Lecture 100", "completed", "vi", LocalDateTime.now(), 3L);
        when(subjectService.listMeetings(3L, 9L, 1, 100))
                .thenReturn(new PageResponse<>(List.of(meeting), 1, 1, 100, 1));

        mockMvc.perform(get("/internal/subjects/3/meetings")
                        .param("page", "1")
                        .param("pageSize", "100")
                        .header("X-Internal-Service-Token", TOKEN)
                        .header("X-Owner-User-Id", "9"))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.items").isArray())
                .andExpect(jsonPath("$.items[0].id").value(100))
                .andExpect(jsonPath("$.items[0].subjectId").value(3))
                .andExpect(jsonPath("$.page").value(1))
                .andExpect(jsonPath("$.pageSize").value(100))
                .andExpect(jsonPath("$.total").value(1))
                .andExpect(jsonPath("$.totalPages").value(1));

        verify(subjectService).listMeetings(eq(3L), eq(9L), eq(1), eq(100));
    }

    @Test
    void listMeetings_badToken_returns401() throws Exception {
        mockMvc.perform(get("/internal/subjects/3/meetings")
                        .header("X-Internal-Service-Token", "wrong")
                        .header("X-Owner-User-Id", "9"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void listMeetings_missingToken_returns401() throws Exception {
        mockMvc.perform(get("/internal/subjects/3/meetings")
                        .header("X-Owner-User-Id", "9"))
                .andExpect(status().isUnauthorized());
    }

    @Test
    void listMeetings_wrongOwner_returns404() throws Exception {
        when(subjectService.listMeetings(3L, 99L, 1, 100))
                .thenThrow(new NoSuchElementException("Subject not found"));

        mockMvc.perform(get("/internal/subjects/3/meetings")
                        .param("page", "1")
                        .param("pageSize", "100")
                        .header("X-Internal-Service-Token", TOKEN)
                        .header("X-Owner-User-Id", "99"))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.error").value("RESOURCE_NOT_FOUND"));
    }
}
