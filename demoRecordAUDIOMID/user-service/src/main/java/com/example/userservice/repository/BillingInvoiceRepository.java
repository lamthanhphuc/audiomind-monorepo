package com.example.userservice.repository;

import com.example.userservice.entity.BillingInvoice;
import java.util.List;
import java.util.Optional;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BillingInvoiceRepository extends JpaRepository<BillingInvoice, Long> {
    Optional<BillingInvoice> findByOrderCode(long orderCode);
    List<BillingInvoice> findTop50ByUserIdOrderByCreatedAtDesc(Long userId);
    List<BillingInvoice> findByOrderByCreatedAtDesc(Pageable pageable);
    List<BillingInvoice> findByUserIdOrderByCreatedAtDesc(Long userId, Pageable pageable);
    List<BillingInvoice> findByStatusIgnoreCaseOrderByCreatedAtDesc(String status, Pageable pageable);
    List<BillingInvoice> findByUserIdAndStatusIgnoreCaseOrderByCreatedAtDesc(Long userId, String status, Pageable pageable);
}

