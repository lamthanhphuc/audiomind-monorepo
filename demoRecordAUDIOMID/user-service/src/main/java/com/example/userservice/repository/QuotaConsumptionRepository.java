package com.example.userservice.repository;

import com.example.userservice.entity.QuotaConsumption;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface QuotaConsumptionRepository extends JpaRepository<QuotaConsumption, Long> {

    Optional<QuotaConsumption> findByOwnerUserIdAndIdempotencyKey(Long ownerUserId, String idempotencyKey);

    List<QuotaConsumption> findByOwnerUserIdAndCreatedAtBetweenOrderByCreatedAtDesc(
            Long ownerUserId,
            Instant from,
            Instant to,
            Pageable pageable
    );
}
