package com.example.meetingservice.interfaces.http;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;
import org.mockito.Mockito;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import com.example.meetingservice.application.MeetingRecordApplicationService;
import com.example.meetingservice.interfaces.http.dto.UpdateMeetingResultRequest;

class MeetingV1ControllerTest {

    @Test
    void legacyEndpoints_shouldBeDeprecatedWithNotFound() {
        MeetingV1Controller controller = new MeetingV1Controller(Mockito.mock(MeetingRecordApplicationService.class));

        ResponseStatusException createEx = assertThrows(ResponseStatusException.class, controller::createMeeting);
        assertEquals(HttpStatus.NOT_FOUND, createEx.getStatusCode());

        ResponseStatusException getEx = assertThrows(ResponseStatusException.class, () -> controller.getMeeting("meeting-1"));
        assertEquals(HttpStatus.NOT_FOUND, getEx.getStatusCode());

        ResponseStatusException updateEx = assertThrows(
                ResponseStatusException.class,
                () -> controller.updateResult("meeting-1", new UpdateMeetingResultRequest("raw", "summary"))
        );
        assertEquals(HttpStatus.NOT_FOUND, updateEx.getStatusCode());
    }
}
