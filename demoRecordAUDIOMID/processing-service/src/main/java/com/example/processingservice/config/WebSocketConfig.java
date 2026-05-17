package com.example.processingservice.config;

import com.example.processingservice.interfaces.websocket.MeetingWebSocketHandler;
import com.example.processingservice.interfaces.websocket.WebSocketJwtHandshakeInterceptor;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;
import org.springframework.web.socket.server.standard.ServletServerContainerFactoryBean;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final MeetingWebSocketHandler meetingWebSocketHandler;
    private final WebSocketJwtHandshakeInterceptor handshakeInterceptor;

    // Reasonable buffer sizes to prevent OutOfMemoryError
    // Text messages (transcripts, status): 1MB per message
    private static final int WS_MAX_TEXT_MESSAGE_SIZE = 1 * 1024 * 1024; // 1MB
    
    // Binary messages (audio chunks): 10MB per message
    // This allows multiple chunks to be buffered but prevents unbounded memory growth
    private static final int WS_MAX_BINARY_MESSAGE_SIZE = 10 * 1024 * 1024; // 10MB

    public WebSocketConfig(
            MeetingWebSocketHandler meetingWebSocketHandler,
            WebSocketJwtHandshakeInterceptor handshakeInterceptor
    ) {
        this.meetingWebSocketHandler = meetingWebSocketHandler;
        this.handshakeInterceptor = handshakeInterceptor;
    }

    /**
     * Configure WebSocket buffer sizes at the servlet container level.
     * This ensures buffers are properly set BEFORE Spring creates the WebSocket session.
     * Critical: Reasonable buffer sizes prevent OutOfMemoryError on high load.
     */
    @Bean
    public ServletServerContainerFactoryBean createWebSocketContainer() {
        ServletServerContainerFactoryBean container = new ServletServerContainerFactoryBean();
        
        // Set max text message buffer size (for transcript, status messages, etc.)
        container.setMaxTextMessageBufferSize(WS_MAX_TEXT_MESSAGE_SIZE);
        
        // Set max binary message buffer size (for audio chunks)
        container.setMaxBinaryMessageBufferSize(WS_MAX_BINARY_MESSAGE_SIZE);
        
        // Set async send timeout to 30 seconds (reduce from 60 to prevent stuck connections)
        container.setAsyncSendTimeout(30000L);
        return container;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(meetingWebSocketHandler, "/ws/meetings/{meetingId}")
                .addInterceptors(handshakeInterceptor)
                .setAllowedOriginPatterns("*");
    }
}
