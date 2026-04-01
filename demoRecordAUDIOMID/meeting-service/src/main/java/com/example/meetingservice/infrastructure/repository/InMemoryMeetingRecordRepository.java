package com.example.meetingservice.infrastructure.repository;

import com.example.meetingservice.domain.model.MeetingRecord;
import com.example.meetingservice.domain.repository.MeetingRecordRepository;
import org.springframework.stereotype.Repository;

import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

@Repository
public class InMemoryMeetingRecordRepository implements MeetingRecordRepository {

    private final Map<String, MeetingRecord> store = new ConcurrentHashMap<>();

    @Override
    public MeetingRecord save(MeetingRecord meetingRecord) {
        store.put(meetingRecord.id(), meetingRecord);
        return meetingRecord;
    }

    @Override
    public Optional<MeetingRecord> findById(String id) {
        return Optional.ofNullable(store.get(id));
    }
}
