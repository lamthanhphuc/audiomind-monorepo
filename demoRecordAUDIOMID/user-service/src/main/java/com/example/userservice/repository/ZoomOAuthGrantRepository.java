package com.example.userservice.repository;

import com.example.userservice.entity.ZoomOAuthGrant;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface ZoomOAuthGrantRepository extends JpaRepository<ZoomOAuthGrant, Long> {

    Optional<ZoomOAuthGrant> findByUserIdAndRevokedAtIsNull(Long userId);

    Optional<ZoomOAuthGrant> findByZoomUserIdAndRevokedAtIsNull(String zoomUserId);
}
