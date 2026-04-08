package com.example.processingservice.interfaces.http;

import com.example.processingservice.application.ProcessMeetingJobUseCase;
import com.example.processingservice.domain.model.ProcessingJobResult;
import com.example.processingservice.interfaces.http.dto.CreateJobRequest;
import com.example.processingservice.interfaces.http.dto.JobResponse;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@CrossOrigin(origins = "${CORS_ALLOWED_ORIGINS:http://localhost:5173}")
@RestController
@RequestMapping("/api/v1/jobs")
@RequiredArgsConstructor
public class ProcessingV1Controller {

    private final ProcessMeetingJobUseCase processMeetingJobUseCase;

    @PostMapping
    public JobResponse createJob(@RequestBody CreateJobRequest request) {
        ProcessingJobResult result = processMeetingJobUseCase.processMeeting(request.meetingId());
        return new JobResponse(
                result.meetingId(),
                result.status(),
                result.transcript(),
                result.summary()
        );
    }
}
