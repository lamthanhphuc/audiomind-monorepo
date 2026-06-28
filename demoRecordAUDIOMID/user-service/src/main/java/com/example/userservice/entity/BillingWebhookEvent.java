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
        name = "billing_webhook_events",
        indexes = {
                @Index(name = "idx_billing_webhook_events_order_code", columnList = "order_code")
        }
)
@Getter
@Setter
public class BillingWebhookEvent {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "provider", nullable = false, length = 30)
    private String provider = "PAYOS";

    @Column(name = "order_code")
    private Long orderCode;

    @Column(name = "payment_link_id", length = 255)
    private String paymentLinkId;

    @Column(name = "event_code", length = 50)
    private String eventCode;

    @Column(name = "event_desc", length = 255)
    private String eventDesc;

    @Column(name = "success")
    private Boolean success;

    @Column(name = "received_at", nullable = false)
    private Instant receivedAt = Instant.now();

    @Column(name = "signature", length = 255)
    private String signature;

    @Column(name = "payload_json", columnDefinition = "TEXT")
    private String payloadJson;
}

