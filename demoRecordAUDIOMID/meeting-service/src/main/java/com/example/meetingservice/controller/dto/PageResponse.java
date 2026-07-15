package com.example.meetingservice.controller.dto;

import java.util.List;

public record PageResponse<T>(List<T> items, long total, int page, int pageSize, int totalPages) {}
