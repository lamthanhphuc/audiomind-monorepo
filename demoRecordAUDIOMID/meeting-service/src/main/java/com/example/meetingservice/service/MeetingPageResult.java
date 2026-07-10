package com.example.meetingservice.service;

import com.example.meetingservice.entity.Meeting;
import java.util.List;

public record MeetingPageResult(
        List<Meeting> items,
        long total,
        int page,
        int pageSize,
        int totalPages
) {
}
