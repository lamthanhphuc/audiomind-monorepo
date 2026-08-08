package com.example.userservice.repository;

import com.example.userservice.entity.SubscriptionPlan;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface SubscriptionPlanRepository extends JpaRepository<SubscriptionPlan, Long> {
    List<SubscriptionPlan> findByActiveTrueOrderBySortOrderAscIdAsc();
    List<SubscriptionPlan> findAllByOrderBySortOrderAscIdAsc();
    Optional<SubscriptionPlan> findByCodeIgnoreCase(String code);
    boolean existsByCodeIgnoreCase(String code);
}
