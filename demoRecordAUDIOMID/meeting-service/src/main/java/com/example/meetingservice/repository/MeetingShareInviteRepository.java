package com.example.meetingservice.repository;

import com.example.meetingservice.entity.MeetingShareInvite;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingShareInviteRepository extends JpaRepository<MeetingShareInvite, Long> {

    List<MeetingShareInvite> findByMeetingIdAndStatusOrderByCreatedAtAsc(Long meetingId, String status);

    List<MeetingShareInvite> findByInviteeEmailAndStatusOrderByCreatedAtAsc(String inviteeEmail, String status);

    Optional<MeetingShareInvite> findByMeetingIdAndInviteeEmailAndStatus(
            Long meetingId,
            String inviteeEmail,
            String status
    );

    boolean existsByMeetingIdAndInviteeEmailAndStatus(Long meetingId, String inviteeEmail, String status);

    void deleteByMeetingIdAndInviteeEmailAndStatus(Long meetingId, String inviteeEmail, String status);
}
