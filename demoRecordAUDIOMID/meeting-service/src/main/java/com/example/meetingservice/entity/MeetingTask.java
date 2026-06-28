package com.example.meetingservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Entity
@Table(name = "meeting_task")
@Data
public class MeetingTask {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "meeting_id", nullable = false)
    private Long meetingId;

    @Column(nullable = false, length = 500)
    private String title;

    @Column(length = 200)
    private String owner;

    @Column(length = 100)
    private String deadline;

    @Column(nullable = false, length = 20)
    private String priority = "medium";

    @Column(nullable = false, length = 30)
    private String status = "open";

    @Column(name = "source_key", length = 200)
    private String sourceKey;

    @Column(name = "created_by_user_id", nullable = false)
    private Long createdByUserId;

    @Column(name = "created_at", nullable = false)
    private LocalDateTime createdAt;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;
}
