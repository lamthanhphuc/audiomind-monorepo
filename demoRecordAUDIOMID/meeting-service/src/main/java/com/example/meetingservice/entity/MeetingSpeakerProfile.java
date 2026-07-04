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
@Table(name = "meeting_speaker_profile")
@Data
public class MeetingSpeakerProfile {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "meeting_id", nullable = false)
    private Long meetingId;

    @Column(name = "speaker_key", nullable = false, length = 120)
    private String speakerKey;

    @Column(name = "display_name", nullable = false, length = 200)
    private String displayName;

    @Column(length = 24)
    private String color;

    @Column(name = "avatar_url")
    private String avatarUrl;

    @Column(name = "created_by_user_id", nullable = false)
    private Long createdByUserId;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;
}
