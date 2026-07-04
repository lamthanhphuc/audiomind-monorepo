package com.example.meetingservice.repository;

import com.example.meetingservice.entity.MeetingShare;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingShareRepository extends JpaRepository<MeetingShare, Long> {

    List<MeetingShare> findByMeetingIdOrderByCreatedAtAsc(Long meetingId);

    List<MeetingShare> findBySharedWithUserIdOrderByCreatedAtDesc(Long sharedWithUserId);

    Optional<MeetingShare> findByMeetingIdAndSharedWithUserId(Long meetingId, Long sharedWithUserId);

    boolean existsByMeetingIdAndSharedWithUserId(Long meetingId, Long sharedWithUserId);

    void deleteByMeetingIdAndSharedWithUserId(Long meetingId, Long sharedWithUserId);
}
