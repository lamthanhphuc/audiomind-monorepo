package com.example.userservice.entity;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.GeneratedValue;
import jakarta.persistence.GenerationType;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import lombok.Getter;
import lombok.Setter;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

@Entity
@Table(name = "google_oauth_grants")
@Getter
@Setter
public class GoogleOAuthGrant {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @Column(name = "user_id", nullable = false)
    private Long userId;

    @Column(name = "google_sub", nullable = false, length = 255)
    private String googleSub;

    @Column(name = "encrypted_refresh_token")
    private String encryptedRefreshToken;

    @Column(name = "token_iv", length = 255)
    private String tokenIv;

    @Column(name = "token_kid", length = 100)
    private String tokenKid;

    @JdbcTypeCode(SqlTypes.ARRAY)
    @Column(name = "granted_scopes", nullable = false, columnDefinition = "text[]")
    private List<String> grantedScopes = new ArrayList<>();

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;
}
