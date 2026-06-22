package com.example.meetingservice.service;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class ClamAvScanner implements UploadSecurityScanner {

    private static final Logger log = LoggerFactory.getLogger(ClamAvScanner.class);
    private static final int CHUNK_SIZE = 64 * 1024;

    private final String socketPath;
    private final ScanCircuitBreaker circuitBreaker;

    public ClamAvScanner(
            @Value("${upload.security.clamav.socket:/var/run/clamav/clamd.ctl}") String socketPath,
            ScanCircuitBreaker circuitBreaker
    ) {
        this.socketPath = socketPath;
        this.circuitBreaker = circuitBreaker;
    }

    @Override
    public ScanResult scan(Path path, String traceId) {
        if (circuitBreaker.isOpen()) {
            log.warn("event=UPLOAD_SCAN_CIRCUIT_OPEN traceId={}", traceId);
            return ScanResult.INFRA_ERROR;
        }

        try {
            byte[] payload = Files.readAllBytes(path);
            String response = sendInstream(payload);
            String normalized = response == null ? "" : response.trim();
            if (normalized.endsWith("OK")) {
                circuitBreaker.recordSuccess();
                log.info("event=UPLOAD_SCAN_PASSED traceId={}", traceId);
                return ScanResult.PASSED;
            }
            if (normalized.contains("FOUND")) {
                circuitBreaker.recordSuccess();
                log.warn("event=UPLOAD_SCAN_FAILED traceId={}", traceId);
                return ScanResult.FAILED;
            }
            circuitBreaker.recordFailure();
            log.warn("event=UPLOAD_SCAN_INFRA_ERROR traceId={} reason=unexpected_response", traceId);
            return ScanResult.INFRA_ERROR;
        } catch (IOException ioError) {
            circuitBreaker.recordFailure();
            log.warn(
                    "event=UPLOAD_SCAN_INFRA_ERROR traceId={} errorCode={}",
                    traceId,
                    ioError.getClass().getSimpleName()
            );
            return ScanResult.INFRA_ERROR;
        }
    }

    String sendInstream(byte[] payload) throws IOException {
        UnixDomainSocketAddress address = UnixDomainSocketAddress.of(socketPath);
        try (SocketChannel channel = SocketChannel.open(StandardProtocolFamily.UNIX)) {
            channel.connect(address);
            try (OutputStream output = java.nio.channels.Channels.newOutputStream(channel)) {
                output.write("zINSTREAM\0".getBytes(StandardCharsets.US_ASCII));
                int offset = 0;
                while (offset < payload.length) {
                    int length = Math.min(CHUNK_SIZE, payload.length - offset);
                    ByteBuffer sizeBuffer = ByteBuffer.allocate(4).putInt(length);
                    sizeBuffer.flip();
                    output.write(sizeBuffer.array());
                    output.write(payload, offset, length);
                    offset += length;
                }
                output.write(new byte[] {0, 0, 0, 0});
                output.flush();
            }

            try (InputStream input = java.nio.channels.Channels.newInputStream(channel)) {
                return new String(input.readAllBytes(), StandardCharsets.US_ASCII);
            }
        }
    }
}
