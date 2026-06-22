package com.example.meetingservice.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "epic2")
public class Epic2FeatureFlags {

    private boolean errorUxEnabled = true;
    private boolean uploadValidationStrict = false;
    private boolean mimeSniffEnabled = false;
    private boolean realtimeValidationEnabled = false;
    private boolean uploadSecurityScanEnabled = false;
    private boolean uploadScanFailOpen = true;

    public boolean isErrorUxEnabled() {
        return errorUxEnabled;
    }

    public void setErrorUxEnabled(boolean errorUxEnabled) {
        this.errorUxEnabled = errorUxEnabled;
    }

    public boolean isUploadValidationStrict() {
        return uploadValidationStrict;
    }

    public void setUploadValidationStrict(boolean uploadValidationStrict) {
        this.uploadValidationStrict = uploadValidationStrict;
    }

    public boolean isMimeSniffEnabled() {
        return mimeSniffEnabled;
    }

    public void setMimeSniffEnabled(boolean mimeSniffEnabled) {
        this.mimeSniffEnabled = mimeSniffEnabled;
    }

    public boolean isRealtimeValidationEnabled() {
        return realtimeValidationEnabled;
    }

    public void setRealtimeValidationEnabled(boolean realtimeValidationEnabled) {
        this.realtimeValidationEnabled = realtimeValidationEnabled;
    }

    public boolean isUploadSecurityScanEnabled() {
        return uploadSecurityScanEnabled;
    }

    public void setUploadSecurityScanEnabled(boolean uploadSecurityScanEnabled) {
        this.uploadSecurityScanEnabled = uploadSecurityScanEnabled;
    }

    public boolean isUploadScanFailOpen() {
        return uploadScanFailOpen;
    }

    public void setUploadScanFailOpen(boolean uploadScanFailOpen) {
        this.uploadScanFailOpen = uploadScanFailOpen;
    }
}
