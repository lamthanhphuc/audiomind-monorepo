# AudioMind - Integration Guide

## Microservice Architecture Overview

```
┌─────────────────────┐         ┌──────────────────────┐
│                     │         │                      │
│  Frontend/Client    │────────▶│  meeting-service     │
│  (Next.js/React)    │         │  (Spring Boot 8081)  │
│                     │         │                      │
└─────────────────────┘         └──────────┬───────────┘
                                           │
                                           │ Upload audio
                                           │ Create meeting
                                           ▼
                                ┌──────────────────────┐
                                │  PostgreSQL DB       │
                                │  (meetings table)    │
                                └──────────────────────┘
                                           
                                           
┌─────────────────────┐         ┌──────────────────────┐
│                     │         │                      │
│  Frontend/Client    │────────▶│ processing-service   │
│                     │         │  (Spring Boot 8082)  │
└─────────────────────┘         └──────────┬───────────┘
                                           │
                                           │ Request processing
                                           ▼
                                ┌──────────────────────┐
                                │   ai-service         │
                                │   (FastAPI 8000)     │
                                │                      │
                                │  - Whisper STT       │
                                │  - Speaker Diarize   │
                                │  - AI Analysis       │
                                └──────────┬───────────┘
                                           │
                                           │ Save results
                                           ▼
                                ┌──────────────────────┐
                                │  PostgreSQL DB       │
                                │  (transcripts,       │
                                │   analysis tables)   │
                                └──────────────────────┘
```

## Service Communication Flow

### 1. Upload Meeting Audio

**Client → meeting-service**

```http
POST http://localhost:8081/meetings/upload
Content-Type: multipart/form-data

title: "Team Standup Meeting"
file: meeting.wav
```

**Response:**
```json
{
  "id": 1,
  "title": "Team Standup Meeting",
  "audioPath": "uploads/meeting.wav",
  "createdAt": "2024-01-01T10:00:00"
}
```

### 2. Request Processing

**Client → processing-service**

```http
POST http://localhost:8082/processing/start?meetingId=1
```

**processing-service → ai-service**

```http
POST http://localhost:8000/api/process
Content-Type: application/json

{
  "audio_path": "uploads/meeting.wav"
}
```

**Response:**
```json
{
  "meeting_id": 1,
  "status": "completed",
  "message": "Processing completed successfully"
}
```

### 3. Retrieve Results

**Get Transcript:**
```http
GET http://localhost:8000/api/meeting/1/transcript
```

**Response:**
```json
{
  "meeting_id": 1,
  "transcripts": [
    {
      "speaker": "SPEAKER_1",
      "start_time": 0.5,
      "end_time": 5.2,
      "text": "We should deploy Kubernetes next week"
    },
    {
      "speaker": "SPEAKER_2",
      "start_time": 5.5,
      "end_time": 9.8,
      "text": "I will handle the docker pipeline"
    }
  ]
}
```

**Get Analysis:**
```http
GET http://localhost:8000/api/meeting/1/analysis
```

**Response:**
```json
{
  "meeting_id": 1,
  "summary": "The team discussed deployment plans...",
  "keywords": ["kubernetes", "deployment", "docker"],
  "technical_terms": ["kubernetes", "docker", "pipeline"],
  "action_items": [
    {
      "task": "Prepare docker pipeline",
      "owner": "John",
      "deadline": "next week"
    }
  ],
  "created_at": "2024-01-01T10:05:00"
}
```

## Updating Spring Boot Services

### Option 1: Update Processing Service (Recommended)

Update `ProcessingController.java` to provide comprehensive endpoints:

```java
package com.example.processingservice.controller;

import com.example.processingservice.service.ProcessingService;
import lombok.RequiredArgsConstructor;
import org.springframework.web.bind.annotation.*;

@RestController
@RequestMapping("/processing")
@RequiredArgsConstructor
public class ProcessingController {

    private final ProcessingService processingService;

    @PostMapping("/start")
    public Map<String, Object> startProcessing(@RequestParam Long meetingId) {
        return processingService.processMeeting(meetingId);
    }

    @GetMapping("/{meetingId}/transcript")
    public Map<String, Object> getTranscript(@PathVariable Long meetingId) {
        return processingService.getTranscript(meetingId);
    }

    @GetMapping("/{meetingId}/analysis")
    public Map<String, Object> getAnalysis(@PathVariable Long meetingId) {
        return processingService.getAnalysis(meetingId);
    }

    @GetMapping("/{meetingId}/status")
    public Map<String, String> getStatus(@PathVariable Long meetingId) {
        return processingService.getProcessingStatus(meetingId);
    }
}
```

Update `ProcessingService.java`:

```java
package com.example.processingservice.service;

import com.example.processingservice.client.AIServiceClient;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class ProcessingService {

    private final AIServiceClient aiServiceClient;
    private final RestTemplate restTemplate;

    public Map<String, Object> processMeeting(Long meetingId) {
        // 1. Get meeting info from meeting-service
        String meetingUrl = "http://localhost:8081/meetings/" + meetingId;
        Map<String, Object> meeting = restTemplate.getForObject(meetingUrl, Map.class);
        
        String audioPath = (String) meeting.get("audioPath");
        
        // 2. Send to AI service for processing
        String result = aiServiceClient.processAudio(audioPath);
        
        Map<String, Object> response = new HashMap<>();
        response.put("meetingId", meetingId);
        response.put("status", "processing_started");
        response.put("message", result);
        
        return response;
    }

    public Map<String, Object> getTranscript(Long meetingId) {
        String url = "http://localhost:8000/api/meeting/" + meetingId + "/transcript";
        return restTemplate.getForObject(url, Map.class);
    }

    public Map<String, Object> getAnalysis(Long meetingId) {
        String url = "http://localhost:8000/api/meeting/" + meetingId + "/analysis";
        return restTemplate.getForObject(url, Map.class);
    }

    public Map<String, String> getProcessingStatus(Long meetingId) {
        // You can implement status tracking if needed
        Map<String, String> status = new HashMap<>();
        status.put("meetingId", meetingId.toString());
        status.put("status", "completed");
        return status;
    }
}
```

Update `AIServiceClient.java`:

```java
package com.example.processingservice.client;

import lombok.RequiredArgsConstructor;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Service;
import org.springframework.web.client.RestTemplate;

import java.util.HashMap;
import java.util.Map;

@Service
@RequiredArgsConstructor
public class AIServiceClient {

    private final RestTemplate restTemplate;

    @Value("${ai.service.url}")
    private String aiUrl;

    public String processAudio(String audioPath) {
        Map<String, String> request = new HashMap<>();
        request.put("audio_path", audioPath);

        ResponseEntity<Map> response = restTemplate.postForEntity(
            aiUrl + "/api/process",
            request,
            Map.class
        );

        Map<String, Object> body = response.getBody();
        return (String) body.get("message");
    }

    public Map<String, Object> getTranscript(Long meetingId) {
        String url = aiUrl + "/api/meeting/" + meetingId + "/transcript";
        return restTemplate.getForObject(url, Map.class);
    }

    public Map<String, Object> getAnalysis(Long meetingId) {
        String url = aiUrl + "/api/meeting/" + meetingId + "/analysis";
        return restTemplate.getForObject(url, Map.class);
    }
}
```

### Option 2: Add Meeting Service Endpoint

In `MeetingController.java`:

```java
@GetMapping("/{id}")
public Meeting getMeeting(@PathVariable Long id) {
    return meetingService.findById(id);
}
```

In `MeetingService.java`:

```java
public Meeting findById(Long id) {
    return meetingRepository.findById(id)
        .orElseThrow(() -> new RuntimeException("Meeting not found"));
}
```

## Database Sharing

Both Java and Python services use the same PostgreSQL database:

**Database:** `audiomind`

**Tables:**
- `meeting` - Created by meeting-service (Spring Boot)
- `transcripts` - Created by ai-service (FastAPI)
- `analysis` - Created by ai-service (FastAPI)

**Connection:**
```
Host: localhost
Port: 5432
Database: audiomind
User: postgres
Password: postgres
```

## Testing the Complete Flow

### 1. Start all services

```bash
# Terminal 1: Start PostgreSQL
docker-compose up postgres -d

# Terminal 2: Start meeting-service
cd meeting-service
./mvnw spring-boot:run

# Terminal 3: Start processing-service
cd processing-service
./mvnw spring-boot:run

# Terminal 4: Start ai-service
cd ai-service
start.bat  # Windows
# or
./start.sh  # Linux/Mac
```

### 2. Upload audio

```bash
curl -X POST http://localhost:8081/meetings/upload \
  -F "title=Test Meeting" \
  -F "file=@test_meeting.wav"
```

### 3. Start processing

```bash
curl -X POST http://localhost:8082/processing/start?meetingId=1
```

### 4. Get results

```bash
# Get transcript
curl http://localhost:8082/processing/1/transcript

# Get analysis
curl http://localhost:8082/processing/1/analysis
```

## Environment Configuration

### meeting-service (application.yml)
```yaml
server:
  port: 8081

spring:
  datasource:
    url: jdbc:postgresql://localhost:5432/audiomind
    username: postgres
    password: postgres
```

### processing-service (application.yml)
```yaml
server:
  port: 8082

ai:
  service:
    url: http://localhost:8000
```

### ai-service (.env)
```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/audiomind
OPENAI_API_KEY=your_key_here
HUGGINGFACE_TOKEN=your_token_here
PORT=8000
```

## Common Issues

### Port conflicts
- meeting-service: 8081
- processing-service: 8082
- ai-service: 8000
- postgres: 5432

Make sure no other services are using these ports.

### CORS issues
AI service has CORS enabled for all origins. If you need to restrict:

```python
# app/main.py
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000"],  # Your frontend URL
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)
```

### File path issues
Make sure audio files uploaded to meeting-service are accessible by ai-service.

**Option 1:** Shared volume (Docker)
```yaml
# docker-compose.yml
volumes:
  - ./uploads:/app/uploads
```

**Option 2:** Same file system
Both services run on same machine with shared uploads folder.

**Option 3:** Update audio path
Convert relative path to absolute path when calling AI service.

## Next Steps

1. **Add async processing** - Use message queue (RabbitMQ/Kafka) for long-running tasks
2. **Add status tracking** - Track processing status in database
3. **Add WebSocket** - Real-time progress updates
4. **Add caching** - Cache results for faster retrieval
5. **Add authentication** - Secure API endpoints
6. **Add monitoring** - Add logging and metrics
7. **Add frontend** - Build React/Next.js frontend

## Support

For issues or questions:
- Check service logs
- Verify all services are running
- Check database connectivity
- Verify API key configuration
