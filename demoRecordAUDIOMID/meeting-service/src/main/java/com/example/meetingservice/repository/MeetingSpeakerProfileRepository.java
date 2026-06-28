package com.example.meetingservice.repository;

import com.example.meetingservice.entity.MeetingSpeakerProfile;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingSpeakerProfileRepository extends JpaRepository<MeetingSpeakerProfile, Long> {

    List<MeetingSpeakerProfile> findByMeetingIdOrderBySpeakerKeyAsc(Long meetingId);

    Optional<MeetingSpeakerProfile> findByMeetingIdAndSpeakerKey(Long meetingId, String speakerKey);

    void deleteByMeetingIdAndSpeakerKey(Long meetingId, String speakerKey);
}
