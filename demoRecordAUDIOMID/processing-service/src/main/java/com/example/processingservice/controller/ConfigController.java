package com.example.processingservice.controller;

import com.example.processingservice.config.Epic3PolicyLoader;
import java.util.Map;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/config")
public class ConfigController {

    private final Epic3PolicyLoader epic3PolicyLoader;

    public ConfigController(Epic3PolicyLoader epic3PolicyLoader) {
        this.epic3PolicyLoader = epic3PolicyLoader;
    }

    @GetMapping("/transcript-quality")
    public Map<String, Object> transcriptQualityConfig() {
        return epic3PolicyLoader.asMap();
    }
}
