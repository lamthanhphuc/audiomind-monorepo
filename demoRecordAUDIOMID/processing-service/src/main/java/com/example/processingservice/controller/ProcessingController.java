package com.example.processingservice.controller;

import com.example.processingservice.service.ProcessingService;
import lombok.RequiredArgsConstructor;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.CrossOrigin;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;

@CrossOrigin(origins = "http://localhost:5173")
@RestController
@RequestMapping("/processing")
@RequiredArgsConstructor
public class ProcessingController {

    private final ProcessingService processingService;

    @PostMapping("/start")
    public Map<String, Object> process(
            @RequestParam(required = false) String meetingId,
            @RequestParam(required = false) String topic,
            @RequestParam(name = "glossary_terms", required = false) List<String> glossaryTerms) {
        return processingService.startProcessing(parseMeetingId(meetingId), topic, glossaryTerms);
    }

    @PostMapping("/start/{meetingId}")
    public Map<String, Object> processByPath(
            @PathVariable Long meetingId,
            @RequestParam(required = false) String topic,
            @RequestParam(name = "glossary_terms", required = false) List<String> glossaryTerms) {
        return processingService.startProcessing(meetingId, topic, glossaryTerms);
    }

    @GetMapping("/{meetingId}/status")
    public Map<String, Object> status(@PathVariable Long meetingId) {
        return processingService.getProcessingStatus(meetingId);
    }

    @GetMapping("/{meetingId}/transcript")
    public Map<String, Object> transcript(@PathVariable Long meetingId) {
        return processingService.getTranscript(meetingId);
    }

    @GetMapping("/{meetingId}/analysis")
    public Map<String, Object> analysis(@PathVariable Long meetingId) {
        return processingService.getAnalysis(meetingId);
    }

    private Long parseMeetingId(String meetingId) {
        if (meetingId == null || meetingId.isBlank()) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "meetingId is required and must be a positive integer"
            );
        }

        try {
            Long parsed = Long.parseLong(meetingId);
            if (parsed <= 0) {
                throw new NumberFormatException("meetingId must be greater than 0");
            }
            return parsed;
        } catch (NumberFormatException ex) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "meetingId must be a positive integer"
            );
        }
    }
}