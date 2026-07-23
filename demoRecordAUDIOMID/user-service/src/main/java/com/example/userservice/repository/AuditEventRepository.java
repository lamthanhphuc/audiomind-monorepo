package com.example.userservice.repository;

import com.example.userservice.entity.AuditEvent;
import java.time.Instant;
import java.util.List;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AuditEventRepository extends JpaRepository<AuditEvent, Long> {

    List<AuditEvent> findByCreatedAtBetweenOrderByCreatedAtDesc(Instant from, Instant to, Pageable pageable);

    List<AuditEvent> findByActorUserIdAndCreatedAtBetweenOrderByCreatedAtDesc(
            Long actorUserId,
            Instant from,
            Instant to,
            Pageable pageable
    );

    List<AuditEvent> findByEventTypeAndCreatedAtBetweenOrderByCreatedAtDesc(
            String eventType,
            Instant from,
            Instant to,
            Pageable pageable
    );

    List<AuditEvent> findByActorUserIdAndEventTypeAndCreatedAtBetweenOrderByCreatedAtDesc(
            Long actorUserId,
            String eventType,
            Instant from,
            Instant to,
            Pageable pageable
    );
}
