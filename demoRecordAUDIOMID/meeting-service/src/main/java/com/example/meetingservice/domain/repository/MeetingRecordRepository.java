package com.example.meetingservice.domain.repository;

import com.example.meetingservice.domain.model.MeetingRecord;

import java.util.Optional;

public interface MeetingRecordRepository {
    MeetingRecord save(MeetingRecord meetingRecord);

    Optional<MeetingRecord> findById(String id);
}
