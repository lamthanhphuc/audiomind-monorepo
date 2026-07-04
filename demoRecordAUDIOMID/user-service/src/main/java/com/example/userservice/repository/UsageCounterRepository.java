package com.example.userservice.repository;

import com.example.userservice.entity.UsageCounter;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import jakarta.persistence.LockModeType;

public interface UsageCounterRepository extends JpaRepository<UsageCounter, Long> {

    Optional<UsageCounter> findByUserIdAndPeriodYyyymm(Long userId, String periodYyyymm);

    @Lock(LockModeType.PESSIMISTIC_WRITE)
    @Query("select u from UsageCounter u where u.userId = :userId and u.periodYyyymm = :period")
    Optional<UsageCounter> lockByUserAndPeriod(@Param("userId") Long userId, @Param("period") String periodYyyymm);
}

