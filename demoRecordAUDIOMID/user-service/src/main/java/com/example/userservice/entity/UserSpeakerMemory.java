package com.example.userservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.LocalDateTime;
import lombok.Data;

@Entity
@Table(name = "user_speaker_memory")
@Data
public class UserSpeakerMemory {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "speaker_fingerprint", nullable = false, length = 120)
    private String speakerFingerprint;

    @Column(name = "display_name", nullable = false, length = 200)
    private String displayName;

    @Column(name = "usage_count", nullable = false)
    private int usageCount = 1;

    @Column(name = "last_meeting_id")
    private Long lastMeetingId;

    @Column(name = "updated_at", nullable = false)
    private LocalDateTime updatedAt;
}
