package com.example.userservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import java.time.Instant;
import lombok.Getter;
import lombok.Setter;

@Entity
@Table(
        name = "usage_counters",
        indexes = {
                @Index(name = "ux_usage_counters_user_period", columnList = "user_id,period_yyyymm", unique = true),
                @Index(name = "idx_usage_counters_period", columnList = "period_yyyymm")
        }
)
@Getter
@Setter
public class UsageCounter {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "period_yyyymm", nullable = false, length = 6)
    private String periodYyyymm;

    @Column(name = "stt_seconds_used", nullable = false)
    private long sttSecondsUsed;

    @Column(name = "gemini_input_chars_used", nullable = false)
    private long geminiInputCharsUsed;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();
}

