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
        name = "billing_invoices",
        indexes = {
                @Index(name = "ux_billing_invoices_order_code", columnList = "order_code", unique = true),
                @Index(name = "idx_billing_invoices_user", columnList = "user_id"),
                @Index(name = "idx_billing_invoices_status", columnList = "status")
        }
)
@Getter
@Setter
public class BillingInvoice {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "provider", nullable = false, length = 30)
    private String provider = "PAYOS";

    @Column(name = "order_code", nullable = false)
    private long orderCode;

    @Column(name = "payment_link_id", length = 255)
    private String paymentLinkId;

    @Column(name = "amount_vnd", nullable = false)
    private long amountVnd;

    @Column(name = "plan_code", nullable = false, length = 50)
    private String planCode = "STANDARD";

    @Column(name = "currency", nullable = false, length = 10)
    private String currency = "VND";

    @Column(name = "status", nullable = false, length = 30)
    private String status = "PENDING";

    @Column(name = "description", nullable = false, length = 255)
    private String description;

    @Column(name = "checkout_url", columnDefinition = "TEXT")
    private String checkoutUrl;

    @Column(name = "qr_code", columnDefinition = "TEXT")
    private String qrCode;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt = Instant.now();

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt = Instant.now();

    @Column(name = "paid_at")
    private Instant paidAt;

    @Column(name = "cancelled_at")
    private Instant cancelledAt;

    @Column(name = "expired_at")
    private Instant expiredAt;

    @Column(name = "manual_note", columnDefinition = "TEXT")
    private String manualNote;
}

