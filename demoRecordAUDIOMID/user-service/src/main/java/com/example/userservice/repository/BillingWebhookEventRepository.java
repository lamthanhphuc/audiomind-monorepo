package com.example.userservice.repository;

import com.example.userservice.entity.BillingWebhookEvent;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BillingWebhookEventRepository extends JpaRepository<BillingWebhookEvent, Long> {

    boolean existsByProviderAndSignature(String provider, String signature);
}

