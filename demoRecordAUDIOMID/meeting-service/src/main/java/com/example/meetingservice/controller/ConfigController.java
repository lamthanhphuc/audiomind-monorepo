package com.example.meetingservice.controller;

import com.example.meetingservice.config.UploadValidationPolicy;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/config")
public class ConfigController {

    private final UploadValidationPolicy uploadValidationPolicy;

    public ConfigController(UploadValidationPolicy uploadValidationPolicy) {
        this.uploadValidationPolicy = uploadValidationPolicy;
    }

    @GetMapping("/upload")
    public Map<String, Object> uploadConfig() {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("maxUploadBytes", uploadValidationPolicy.maxUploadBytes());
        payload.put("allowedExtensions", uploadValidationPolicy.allowedExtensions());
        payload.put("allowedMimeTypes", uploadValidationPolicy.allowedMimeTypes());
        return payload;
    }
}
