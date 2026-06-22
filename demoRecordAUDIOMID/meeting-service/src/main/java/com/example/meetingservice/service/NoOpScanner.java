package com.example.meetingservice.service;

import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class NoOpScanner implements UploadSecurityScanner {

    private static final Logger log = LoggerFactory.getLogger(NoOpScanner.class);

    @Override
    public ScanResult scan(Path path, String traceId) {
        log.info("event=UPLOAD_SCAN_SKIPPED traceId={} reason=noop_scanner", traceId);
        return ScanResult.PASSED;
    }
}
