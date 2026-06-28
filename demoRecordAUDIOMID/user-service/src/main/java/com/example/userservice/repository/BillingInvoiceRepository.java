package com.example.userservice.repository;

import com.example.userservice.entity.BillingInvoice;
import java.util.List;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BillingInvoiceRepository extends JpaRepository<BillingInvoice, Long> {
    Optional<BillingInvoice> findByOrderCode(long orderCode);
    List<BillingInvoice> findTop50ByUserIdOrderByCreatedAtDesc(Long userId);
}

