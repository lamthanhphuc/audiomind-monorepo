package com.example.meetingservice.repository;

import com.example.meetingservice.entity.MeetingTask;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface MeetingTaskRepository extends JpaRepository<MeetingTask, Long> {

    List<MeetingTask> findByMeetingIdOrderByUpdatedAtDesc(Long meetingId);

    Optional<MeetingTask> findByMeetingIdAndSourceKey(Long meetingId, String sourceKey);

    long countByMeetingId(Long meetingId);
}
