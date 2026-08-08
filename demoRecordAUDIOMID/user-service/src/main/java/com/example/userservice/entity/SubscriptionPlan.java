package com.example.userservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.PrePersist;
import jakarta.persistence.PreUpdate;
import jakarta.persistence.Table;
import java.time.Instant;
import lombok.Getter;
import lombok.Setter;

@Entity
@Table(name = "subscription_plans")
@Getter
@Setter
public class SubscriptionPlan {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(nullable = false, unique = true, length = 50)
    private String code;

    @Column(nullable = false, length = 120)
    private String name;

    @Column(columnDefinition = "TEXT")
    private String description;

    @Column(name = "price_vnd", nullable = false)
    private long priceVnd;

    @Column(nullable = false, length = 10)
    private String currency = "VND";

    @Column(name = "billing_period", nullable = false, length = 30)
    private String billingPeriod = "MONTHLY";

    @Column(name = "advertisement_enabled", nullable = false)
    private boolean advertisementEnabled = true;

    @Column(name = "recording_minutes_limit", nullable = false)
    private long recordingMinutesLimit;

    @Column(name = "ai_analysis_limit", nullable = false)
    private long aiAnalysisLimit;

    @Column(name = "upload_limit", nullable = false)
    private long uploadLimit;

    @Column(name = "flashcard_limit", nullable = false)
    private long flashcardLimit;

    @Column(name = "quiz_limit", nullable = false)
    private long quizLimit;

    @Column(name = "mindmap_limit", nullable = false)
    private long mindmapLimit;

    @Column(name = "export_limit", nullable = false)
    private long exportLimit;

    @Column(name = "features_json", nullable = false, columnDefinition = "TEXT")
    private String featuresJson = "{}";

    @Column(name = "is_active", nullable = false)
    private boolean active = true;

    @Column(name = "sort_order", nullable = false)
    private int sortOrder;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @PrePersist
    void onCreate() {
        Instant now = Instant.now();
        this.createdAt = now;
        this.updatedAt = now;
    }

    @PreUpdate
    void onUpdate() {
        this.updatedAt = Instant.now();
    }
}
