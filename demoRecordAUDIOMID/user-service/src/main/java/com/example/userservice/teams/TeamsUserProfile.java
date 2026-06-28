package com.example.userservice.teams;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.annotation.JsonProperty;

@JsonIgnoreProperties(ignoreUnknown = true)
public record TeamsUserProfile(
        @JsonProperty("id") String id,
        @JsonProperty("mail") String mail,
        @JsonProperty("userPrincipalName") String userPrincipalName
) {
    public String email() {
        if (mail != null && !mail.isBlank()) {
            return mail;
        }
        return userPrincipalName;
    }
}
