package com.example.userservice.logging;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

@Component
public class TraceIdFilter extends OncePerRequestFilter {

    public static final String TRACE_HEADER = "X-Trace-Id";
    public static final String REQUEST_HEADER = "X-Request-ID";
    private static final Logger log = LoggerFactory.getLogger(TraceIdFilter.class);

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain filterChain)
            throws ServletException, IOException {
        long startedAt = System.currentTimeMillis();
        String path = request.getRequestURI();
        String traceId = request.getHeader(TRACE_HEADER);
        if (traceId == null || traceId.isBlank()) {
            traceId = UUID.randomUUID().toString();
        }
        String requestId = request.getHeader(REQUEST_HEADER);
        if (requestId == null || requestId.isBlank()) {
            requestId = traceId;
        }

        MDC.put("traceId", traceId);
        MDC.put("requestId", requestId);
        response.setHeader(TRACE_HEADER, traceId);
        response.setHeader(REQUEST_HEADER, requestId);
        log.info(
                "event=REQUEST_RECEIVED traceId={} requestId={} path={}",
                traceId,
                requestId,
                path
        );

        try {
            filterChain.doFilter(request, response);
            log.info(
                    "event=REQUEST_COMPLETED traceId={} requestId={} path={} httpStatus={} durationMs={}",
                    traceId,
                    requestId,
                    path,
                    response.getStatus(),
                    System.currentTimeMillis() - startedAt
            );
        } catch (Exception ex) {
            log.warn(
                    "event=REQUEST_FAILED traceId={} requestId={} path={} errorCode={} durationMs={}",
                    traceId,
                    requestId,
                    path,
                    ex.getClass().getSimpleName(),
                    System.currentTimeMillis() - startedAt
            );
            throw ex;
        } finally {
            MDC.remove("traceId");
            MDC.remove("requestId");
            MDC.remove("userId");
        }
    }
}
