package com.example.userservice.zoom;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record ZoomUserProfile(
        @JsonProperty("id") String id,
        @JsonProperty("email") String email,
        @JsonProperty("first_name") String firstName,
        @JsonProperty("last_name") String lastName
) {
}
