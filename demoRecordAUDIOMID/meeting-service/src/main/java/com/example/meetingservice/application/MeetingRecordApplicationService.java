package com.example.meetingservice.application;

import com.example.meetingservice.domain.model.MeetingRecord;
import com.example.meetingservice.domain.repository.MeetingRecordRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.NoSuchElementException;
import java.util.UUID;

@Service
@RequiredArgsConstructor
public class MeetingRecordApplicationService {

    private static final String CREATED = "CREATED";
    private final MeetingRecordRepository meetingRecordRepository;

    public MeetingRecord createMeeting() {
        String id = UUID.randomUUID().toString();
        MeetingRecord meetingRecord = new MeetingRecord(id, CREATED, null, null);
        return meetingRecordRepository.save(meetingRecord);
    }

    public MeetingRecord getMeeting(String id) {
        return meetingRecordRepository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
    }

    public MeetingRecord updateMeetingResult(String id, String transcript, String summary) {
        MeetingRecord current = getMeeting(id);
        MeetingRecord updated = new MeetingRecord(
                current.id(),
                "COMPLETED",
                transcript,
                summary
        );
        return meetingRecordRepository.save(updated);
    }
}
