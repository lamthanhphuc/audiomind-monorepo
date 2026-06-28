package com.example.userservice.repository;

import com.example.userservice.entity.UserIdentity;
import java.util.Optional;
import org.springframework.data.jpa.repository.JpaRepository;

public interface UserIdentityRepository extends JpaRepository<UserIdentity, Long> {
    Optional<UserIdentity> findByProviderAndProviderSubAndUnlinkedAtIsNull(String provider, String providerSub);

    Optional<UserIdentity> findByUserIdAndProviderAndUnlinkedAtIsNull(Long userId, String provider);

    Optional<UserIdentity> findFirstByProviderAndProviderSubOrderByLinkedAtDesc(String provider, String providerSub);

    Optional<UserIdentity> findFirstByUserIdAndProviderOrderByLinkedAtDesc(Long userId, String provider);
}
