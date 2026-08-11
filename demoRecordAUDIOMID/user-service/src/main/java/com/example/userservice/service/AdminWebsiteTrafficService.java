package com.example.userservice.service;

import com.fasterxml.jackson.annotation.JsonIgnoreProperties;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

@Service
@RequiredArgsConstructor
public class AdminWebsiteTrafficService {

    private final ObjectMapper objectMapper;

    @Value("${admin.analytics.website-traffic-file:/var/lib/audiomind/analytics/website-traffic.json}")
    private String websiteTrafficFile;

    public WebsiteTrafficView readWebsiteTraffic() {
        Path path = Path.of(websiteTrafficFile);
        if (!Files.isRegularFile(path)) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Website traffic data unavailable");
        }
        try {
            WebsiteTrafficView view = objectMapper.readValue(path.toFile(), WebsiteTrafficView.class);
            return normalize(view);
        } catch (IOException ex) {
            throw new ResponseStatusException(HttpStatus.SERVICE_UNAVAILABLE, "Website traffic data unavailable");
        }
    }

    private WebsiteTrafficView normalize(WebsiteTrafficView view) {
        return new WebsiteTrafficView(
                Math.max(0, view.visits()),
                Math.max(0, view.uniqueVisitors()),
                Math.max(0, view.todayVisits()),
                Math.max(0, view.todayUniqueVisitors()),
                view.observationStart(),
                view.observationEnd(),
                view.source() == null || view.source().isBlank() ? "nginx_access_log" : view.source(),
                view.partialHistory(),
                view.timezone() == null || view.timezone().isBlank() ? "Asia/Ho_Chi_Minh" : view.timezone(),
                view.generatedAt(),
                view.daily() == null ? List.of() : view.daily()
        );
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record WebsiteTrafficView(
            long visits,
            long uniqueVisitors,
            long todayVisits,
            long todayUniqueVisitors,
            String observationStart,
            String observationEnd,
            String source,
            boolean partialHistory,
            String timezone,
            String generatedAt,
            List<DailyTrafficView> daily
    ) {
    }

    @JsonIgnoreProperties(ignoreUnknown = true)
    public record DailyTrafficView(
            String date,
            long visits,
            long uniqueVisitors
    ) {
    }
}
