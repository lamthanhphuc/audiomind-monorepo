package com.example.meetingservice.repository;

import com.example.meetingservice.entity.GoogleCalendarLink;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface GoogleCalendarLinkRepository extends JpaRepository<GoogleCalendarLink, Long> {
    Optional<GoogleCalendarLink> findByMeetingIdAndUserId(Long meetingId, Long userId);

    List<GoogleCalendarLink> findByUserIdOrderByUpdatedAtDesc(Long userId);
}
