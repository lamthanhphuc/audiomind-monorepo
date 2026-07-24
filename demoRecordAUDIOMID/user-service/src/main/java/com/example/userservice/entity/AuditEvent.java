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
        name = "audit_events",
        indexes = {
                @Index(name = "idx_audit_events_actor_created", columnList = "actor_user_id,created_at"),
                @Index(name = "idx_audit_events_type_created", columnList = "event_type,created_at"),
                @Index(name = "idx_audit_events_target", columnList = "target_type,target_id")
        }
)
@Getter
@Setter
public class AuditEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "actor_user_id")
    private Long actorUserId;

    @Column(name = "event_type", nullable = false, length = 80)
    private String eventType;

    @Column(name = "target_type", length = 80)
    private String targetType;

    @Column(name = "target_id", length = 120)
    private String targetId;

    @Column(name = "summary", nullable = false, length = 500)
    private String summary;

    @Column(name = "metadata_json", columnDefinition = "TEXT")
    private String metadataJson;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();
}
