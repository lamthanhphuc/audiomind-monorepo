package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import com.example.meetingservice.repository.MeetingRepository;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;

import java.util.NoSuchElementException;
import java.util.List;

import java.time.LocalDateTime;

@Service
@RequiredArgsConstructor
public class MeetingService {

    private final MeetingRepository meetingRepository;

    public Meeting saveMeeting(String title, String audioPath){

        Meeting meeting = new Meeting();

        meeting.setTitle(title);
        meeting.setAudioPath(audioPath);
        meeting.setCreatedAt(LocalDateTime.now());

        return meetingRepository.save(meeting);
    }

    public Meeting findById(Long id) {
        return meetingRepository.findById(id)
                .orElseThrow(() -> new NoSuchElementException("Meeting not found: " + id));
    }

    public List<Meeting> findRecentMeetings() {
        return meetingRepository.findTop20ByOrderByIdDesc();
    }
}
