package com.example.meetingservice.repository;

import com.example.meetingservice.entity.Meeting;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;

public interface MeetingRepository extends JpaRepository<Meeting,Long> {
	List<Meeting> findTop20ByOrderByIdDesc();
}