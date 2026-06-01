package com.example.meetingservice.interfaces.http;

import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import com.example.meetingservice.application.MeetingRecordApplicationService;
import com.example.meetingservice.domain.model.MeetingRecord;
import com.example.meetingservice.interfaces.http.dto.MeetingResponse;
import com.example.meetingservice.interfaces.http.dto.UpdateMeetingResultRequest;

import lombok.RequiredArgsConstructor;

@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")
@RestController
@RequestMapping("/api/v1/meetings")
@RequiredArgsConstructor
public class MeetingV1Controller {

    private final MeetingRecordApplicationService applicationService;

    @PostMapping
    public MeetingResponse createMeeting() {
        throw deprecatedEndpoint();
    }

    @GetMapping("/{id}")
    public MeetingResponse getMeeting(@PathVariable String id) {
        throw deprecatedEndpoint();
    }

    @PutMapping("/{id}/result")
    public MeetingResponse updateResult(@PathVariable String id, @RequestBody UpdateMeetingResultRequest request) {
        throw deprecatedEndpoint();
    }

    private MeetingResponse toResponse(MeetingRecord meetingRecord) {
        return new MeetingResponse(
                meetingRecord.id(),
                meetingRecord.status(),
                meetingRecord.transcript(),
                meetingRecord.summary()
        );
    }

    private ResponseStatusException deprecatedEndpoint() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Deprecated endpoint");
    }
}
