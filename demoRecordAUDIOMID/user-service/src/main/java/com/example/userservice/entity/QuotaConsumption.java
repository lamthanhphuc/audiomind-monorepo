package com.example.userservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Index;
import jakarta.persistence.Table;
import jakarta.persistence.UniqueConstraint;
import java.time.Instant;
import lombok.Getter;
import lombok.Setter;

@Entity
@Table(
        name = "quota_consumption",
        uniqueConstraints = {
                @UniqueConstraint(
                        name = "uq_quota_consumption_owner_key",
                        columnNames = {"owner_user_id", "idempotency_key"}
                )
        },
        indexes = {
                @Index(name = "ix_quota_consumption_owner_created", columnList = "owner_user_id,created_at")
        }
)
@Getter
@Setter
public class QuotaConsumption {

    public static final String STATUS_ALLOWED = "ALLOWED";
    public static final String STATUS_DENIED = "DENIED";

    public static final String TYPE_LEGACY = "LEGACY";
    public static final String TYPE_STUDY_ARTIFACT = "STUDY_ARTIFACT";
    public static final String TYPE_SUBJECT_SYNTHESIS = "SUBJECT_SYNTHESIS";

    /** @deprecated prefer {@link #TYPE_SUBJECT_SYNTHESIS} */
    @Deprecated
    public static final String TYPE_STUDY_SYNTHESIS = TYPE_SUBJECT_SYNTHESIS;

    public static final String CONSTRAINT_OWNER_KEY = "uq_quota_consumption_owner_key";

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "owner_user_id", nullable = false)
    private Long ownerUserId;

    @Column(name = "idempotency_key", nullable = false, length = 255)
    private String idempotencyKey;

    @Column(name = "quota_type", nullable = false, length = 64)
    private String quotaType;

    @Column(name = "stt_seconds_delta", nullable = false)
    private long sttSecondsDelta;

    @Column(name = "gemini_chars_delta", nullable = false)
    private long geminiCharsDelta;

    @Column(name = "status", nullable = false, length = 32)
    private String status;

    @Column(name = "period_yyyymm", nullable = false, length = 6)
    private String periodYyyymm;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();
}
