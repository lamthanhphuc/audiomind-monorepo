package com.example.processingservice.config;

import com.example.processingservice.interfaces.websocket.MeetingWebSocketHandler;
import com.example.processingservice.interfaces.websocket.WebSocketJwtHandshakeInterceptor;
import org.springframework.context.annotation.Configuration;
import org.springframework.web.socket.config.annotation.EnableWebSocket;
import org.springframework.web.socket.config.annotation.WebSocketConfigurer;
import org.springframework.web.socket.config.annotation.WebSocketHandlerRegistry;

@Configuration
@EnableWebSocket
public class WebSocketConfig implements WebSocketConfigurer {

    private final MeetingWebSocketHandler meetingWebSocketHandler;
    private final WebSocketJwtHandshakeInterceptor handshakeInterceptor;

    public WebSocketConfig(
            MeetingWebSocketHandler meetingWebSocketHandler,
            WebSocketJwtHandshakeInterceptor handshakeInterceptor
    ) {
        this.meetingWebSocketHandler = meetingWebSocketHandler;
        this.handshakeInterceptor = handshakeInterceptor;
    }

    @Override
    public void registerWebSocketHandlers(WebSocketHandlerRegistry registry) {
        registry.addHandler(meetingWebSocketHandler, "/ws/meetings/{meetingId}")
                .addInterceptors(handshakeInterceptor)
                .setAllowedOriginPatterns("*");
    }
}
