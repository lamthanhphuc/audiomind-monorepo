package com.example.meetingservice.service;

import java.nio.file.Path;

public interface UploadSecurityScanner {

    ScanResult scan(Path path, String traceId);
}
