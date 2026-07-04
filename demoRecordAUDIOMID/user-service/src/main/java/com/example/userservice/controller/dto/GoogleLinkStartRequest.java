package com.example.userservice.controller.dto;

import java.util.List;

public record GoogleLinkStartRequest(List<String> additionalScopes, String redirectAfter) {
}
