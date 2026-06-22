package com.example.meetingservice.config;

import com.example.meetingservice.service.ClamAvScanner;
import com.example.meetingservice.service.NoOpScanner;
import com.example.meetingservice.service.UploadSecurityScanner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class UploadSecurityScannerConfig {

    @Bean
    public UploadSecurityScanner uploadSecurityScanner(
            Epic2FeatureFlags featureFlags,
            ClamAvScanner clamAvScanner,
            NoOpScanner noOpScanner
    ) {
        if (featureFlags.isUploadSecurityScanEnabled()) {
            return clamAvScanner;
        }
        return noOpScanner;
    }
}
