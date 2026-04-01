# AudioMind Project - Complete Directory Structure

```
demoRecord/
│
├── meeting-service/                    # Spring Boot - Meeting Management
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/com/example/meetingservice/
│   │   │   │   ├── MeetingServiceApplication.java
│   │   │   │   ├── controller/
│   │   │   │   │   └── MeetingController.java
│   │   │   │   ├── entity/
│   │   │   │   │   └── Meeting.java
│   │   │   │   ├── repository/
│   │   │   │   │   └── MeetingRepository.java
│   │   │   │   └── service/
│   │   │   │       └── MeetingService.java
│   │   │   └── resources/
│   │   │       └── application.yml
│   │   └── test/
│   ├── pom.xml
│   └── uploads/                        # Uploaded audio files
│
├── processing-service/                 # Spring Boot - Processing Orchestration
│   ├── src/
│   │   ├── main/
│   │   │   ├── java/com/example/processingservice/
│   │   │   │   ├── ProcessingServiceApplication.java
│   │   │   │   ├── client/
│   │   │   │   │   └── AIServiceClient.java
│   │   │   │   ├── config/
│   │   │   │   │   └── RestConfig.java
│   │   │   │   ├── controller/
│   │   │   │   │   └── ProcessingController.java
│   │   │   │   └── service/
│   │   │   │       └── ProcessingService.java
│   │   │   └── resources/
│   │   │       └── application.yml
│   │   └── test/
│   └── pom.xml
│
├── ai-service/                         # Python FastAPI - AI Processing
│   ├── app/
│   │   ├── __init__.py
│   │   ├── main.py                     # FastAPI application
│   │   ├── config.py                   # Configuration settings
│   │   ├── database.py                 # Database connection
│   │   ├── models.py                   # SQLAlchemy models
│   │   ├── schemas.py                  # Pydantic schemas
│   │   ├── pipeline.py                 # Main processing pipeline
│   │   └── services/
│   │       ├── __init__.py
│   │       ├── audio_processor.py      # Audio preprocessing
│   │       ├── speech_recognizer.py    # Whisper STT
│   │       ├── speaker_diarizer.py     # Pyannote diarization
│   │       └── ai_analyzer.py          # OpenAI analysis
│   │
│   ├── alembic/                        # Database migrations
│   │   ├── versions/
│   │   │   └── 001_initial.py
│   │   ├── env.py
│   │   └── script.py.mako
│   │
│   ├── storage/                        # Storage directories
│   │   ├── audio/
│   │   └── temp/
│   │
│   ├── logs/                           # Application logs
│   │
│   ├── requirements.txt                # Python dependencies
│   ├── .env.example                    # Environment variables template
│   ├── .env                            # Environment variables (create this)
│   ├── .gitignore
│   ├── Dockerfile                      # Docker configuration
│   ├── docker-compose.yml              # Docker Compose
│   ├── alembic.ini                     # Alembic configuration
│   ├── start.sh                        # Linux/Mac startup script
│   ├── start.bat                       # Windows startup script
│   ├── test_api.py                     # API testing script
│   ├── README.md                       # Main documentation
│   ├── SETUP.md                        # Setup instructions
│   └── INTEGRATION.md                  # Integration guide
│
├── frontend/                           # Next.js Frontend (to be created)
│   ├── src/
│   │   ├── app/
│   │   ├── components/
│   │   └── lib/
│   ├── public/
│   └── package.json
│
├── pom.xml                             # Root Maven configuration
└── README.md                           # Project documentation
```

## Service Ports

- **meeting-service**: 8081
- **processing-service**: 8082
- **ai-service**: 8000
- **PostgreSQL**: 5432
- **Frontend**: 3000 (when implemented)

## Technology Stack

### Backend Services

**meeting-service (Java/Spring Boot)**
- Spring Boot 3.x
- Spring Data JPA
- PostgreSQL
- Lombok

**processing-service (Java/Spring Boot)**
- Spring Boot 3.x
- RestTemplate
- Lombok

**ai-service (Python/FastAPI)**
- FastAPI
- SQLAlchemy
- OpenAI Whisper
- Pyannote.audio
- OpenAI GPT-4
- PostgreSQL

### Frontend (Future)
- Next.js 14
- React 18
- TailwindCSS
- TypeScript

## Database Schema

**Database: audiomind**

```sql
-- Meeting table (created by meeting-service)
CREATE TABLE meeting (
    id BIGSERIAL PRIMARY KEY,
    title VARCHAR(255),
    audio_path VARCHAR(500),
    created_at TIMESTAMP
);

-- Transcripts table (created by ai-service)
CREATE TABLE transcripts (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER NOT NULL,
    speaker VARCHAR(50),
    start_time FLOAT,
    end_time FLOAT,
    text TEXT,
    created_at TIMESTAMP DEFAULT NOW()
);

-- Analysis table (created by ai-service)
CREATE TABLE analysis (
    id SERIAL PRIMARY KEY,
    meeting_id INTEGER UNIQUE NOT NULL,
    summary TEXT,
    keywords JSON,
    technical_terms JSON,
    action_items JSON,
    created_at TIMESTAMP DEFAULT NOW(),
    transcript_id INTEGER REFERENCES transcripts(id)
);
```

## API Endpoints

### meeting-service (8081)

```
POST   /meetings/upload          # Upload audio file
GET    /meetings/{id}            # Get meeting by ID
GET    /meetings                 # List all meetings
```

### processing-service (8082)

```
POST   /processing/start?meetingId={id}    # Start processing
GET    /processing/{id}/transcript         # Get transcript
GET    /processing/{id}/analysis           # Get analysis
GET    /processing/{id}/status             # Get processing status
```

### ai-service (8000)

```
GET    /                         # Root
GET    /health                   # Health check
POST   /api/process              # Process audio
GET    /api/meeting/{id}/transcript        # Get transcript
GET    /api/meeting/{id}/analysis          # Get analysis
```

## Quick Start Guide

### 1. Setup Database

```bash
# Using Docker
docker run -d \
  --name audiomind-postgres \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=audiomind \
  -p 5432:5432 \
  postgres:14

# Or use docker-compose from ai-service
cd ai-service
docker-compose up postgres -d
```

### 2. Start Services

```bash
# Terminal 1: meeting-service
cd meeting-service
./mvnw spring-boot:run

# Terminal 2: processing-service
cd processing-service
./mvnw spring-boot:run

# Terminal 3: ai-service
cd ai-service
# Configure .env first!
start.bat  # Windows
./start.sh # Linux/Mac
```

### 3. Test the System

```bash
# Upload meeting
curl -X POST http://localhost:8081/meetings/upload \
  -F "title=Team Meeting" \
  -F "file=@meeting.wav"

# Process meeting (use ID from upload response)
curl -X POST http://localhost:8082/processing/start?meetingId=1

# Get transcript
curl http://localhost:8082/processing/1/transcript

# Get analysis
curl http://localhost:8082/processing/1/analysis
```

## Development Workflow

### Adding New Features

1. **Backend (Java)**
   - Add endpoints in Controllers
   - Implement logic in Services
   - Update database schema if needed

2. **AI Service (Python)**
   - Add new AI models in `services/`
   - Update pipeline in `pipeline.py`
   - Add new endpoints in `main.py`
   - Create migration: `alembic revision --autogenerate -m "description"`

3. **Frontend (Future)**
   - Add components in `components/`
   - Add pages in `app/`
   - Connect to backend APIs

## Deployment

### Docker Deployment

```bash
# Build all services
docker-compose up --build

# Or individual services
cd ai-service
docker build -t audiomind-ai .
docker run -p 8000:8000 audiomind-ai
```

### Production Considerations

1. **Security**
   - Add authentication (JWT)
   - Secure API keys
   - Use HTTPS
   - Implement rate limiting

2. **Performance**
   - Use GPU for AI processing
   - Implement caching
   - Use message queue for async processing
   - Add load balancing

3. **Monitoring**
   - Add logging (ELK stack)
   - Add metrics (Prometheus)
   - Add tracing (Jaeger)
   - Health checks

4. **Scalability**
   - Containerize all services
   - Use Kubernetes for orchestration
   - Separate compute for AI processing
   - Use cloud storage for audio files

## Contributing

1. Fork the repository
2. Create feature branch
3. Make changes
4. Write tests
5. Submit pull request

## License

MIT License
