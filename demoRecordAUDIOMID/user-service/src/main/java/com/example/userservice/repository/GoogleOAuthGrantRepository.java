package com.example.userservice.repository;

import com.example.userservice.entity.GoogleOAuthGrant;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface GoogleOAuthGrantRepository extends JpaRepository<GoogleOAuthGrant, Long> {
    Optional<GoogleOAuthGrant> findByUserIdAndRevokedAtIsNull(Long userId);

    Optional<GoogleOAuthGrant> findByGoogleSubAndRevokedAtIsNull(String googleSub);

    Optional<GoogleOAuthGrant> findFirstByUserIdOrderByUpdatedAtDesc(Long userId);
}
