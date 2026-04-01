package com.example.meetingservice.interfaces.http;

import com.example.meetingservice.application.MeetingRecordApplicationService;
import com.example.meetingservice.domain.model.MeetingRecord;
import com.example.meetingservice.interfaces.http.dto.MeetingResponse;
import com.example.meetingservice.interfaces.http.dto.UpdateMeetingResultRequest;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@CrossOrigin(origins = "*")
@RestController
@RequestMapping("/api/v1/meetings")
@RequiredArgsConstructor
public class MeetingV1Controller {

    private final MeetingRecordApplicationService applicationService;

    @PostMapping
    public MeetingResponse createMeeting() {
        return toResponse(applicationService.createMeeting());
    }

    @GetMapping("/{id}")
    public MeetingResponse getMeeting(@PathVariable String id) {
        return toResponse(applicationService.getMeeting(id));
    }

    @PutMapping("/{id}/result")
    public MeetingResponse updateResult(@PathVariable String id, @RequestBody UpdateMeetingResultRequest request) {
        return toResponse(applicationService.updateMeetingResult(id, request.transcript(), request.summary()));
    }

    private MeetingResponse toResponse(MeetingRecord meetingRecord) {
        return new MeetingResponse(
                meetingRecord.id(),
                meetingRecord.status(),
                meetingRecord.transcript(),
                meetingRecord.summary()
        );
    }
}
