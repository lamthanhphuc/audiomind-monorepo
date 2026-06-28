package com.example.userservice;

import com.example.userservice.google.GoogleOAuthProperties;
import com.example.userservice.zoom.ZoomOAuthProperties;
import com.example.userservice.teams.TeamsOAuthProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;

@SpringBootApplication
@EnableConfigurationProperties({GoogleOAuthProperties.class, ZoomOAuthProperties.class, TeamsOAuthProperties.class})
public class UserServiceApplication {

    public static void main(String[] args) {
        SpringApplication.run(UserServiceApplication.class, args);
    }

    @Bean
    public ObjectMapper objectMapper() {
        return new ObjectMapper().findAndRegisterModules();
    }
}
