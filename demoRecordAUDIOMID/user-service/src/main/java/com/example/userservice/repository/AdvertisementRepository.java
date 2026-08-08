package com.example.userservice.repository;

import com.example.userservice.entity.Advertisement;
import java.util.List;
import org.springframework.data.jpa.repository.JpaRepository;

public interface AdvertisementRepository extends JpaRepository<Advertisement, Long> {
    List<Advertisement> findAllByOrderByUpdatedAtDescIdDesc();
    List<Advertisement> findByStatusIgnoreCaseOrderByUpdatedAtDescIdDesc(String status);
}
