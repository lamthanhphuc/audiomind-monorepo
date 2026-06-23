package com.example.processingservice.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

@Component
@ConfigurationProperties(prefix = "epic3")
public class Epic3FeatureFlags {

    private boolean transcriptQualityEnabled;
    private boolean domainLexiconEnabled;
    private boolean evidenceQaEnabled;
    private boolean searchVerifyEnabled;
    private boolean exportVerifyEnabled;

    public boolean isTranscriptQualityEnabled() {
        return transcriptQualityEnabled;
    }

    public void setTranscriptQualityEnabled(boolean transcriptQualityEnabled) {
        this.transcriptQualityEnabled = transcriptQualityEnabled;
    }

    public boolean isDomainLexiconEnabled() {
        return domainLexiconEnabled;
    }

    public void setDomainLexiconEnabled(boolean domainLexiconEnabled) {
        this.domainLexiconEnabled = domainLexiconEnabled;
    }

    public boolean isEvidenceQaEnabled() {
        return evidenceQaEnabled;
    }

    public void setEvidenceQaEnabled(boolean evidenceQaEnabled) {
        this.evidenceQaEnabled = evidenceQaEnabled;
    }

    public boolean isSearchVerifyEnabled() {
        return searchVerifyEnabled;
    }

    public void setSearchVerifyEnabled(boolean searchVerifyEnabled) {
        this.searchVerifyEnabled = searchVerifyEnabled;
    }

    public boolean isExportVerifyEnabled() {
        return exportVerifyEnabled;
    }

    public void setExportVerifyEnabled(boolean exportVerifyEnabled) {
        this.exportVerifyEnabled = exportVerifyEnabled;
    }
}
