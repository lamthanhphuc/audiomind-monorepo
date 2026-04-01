# AudioMind AI Service - Setup Guide

## Quick Start

### 1. Prerequisites

- Python 3.9 or higher
- PostgreSQL 14+
- FFmpeg
- CUDA (optional, for GPU acceleration)

### 2. Installation

#### Windows

```bash
# Run the startup script
start.bat
```

#### Linux/Mac

```bash
# Make script executable
chmod +x start.sh

# Run the startup script
./start.sh
```

### 3. Manual Setup

If you prefer manual setup:

```bash
# Create virtual environment
python -m venv venv

# Activate virtual environment
# Windows:
venv\Scripts\activate
# Linux/Mac:
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Create .env file
cp .env.example .env

# Edit .env with your API keys
# - OPENAI_API_KEY
# - HUGGINGFACE_TOKEN

# Run migrations
alembic upgrade head

# Start server
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
```

## Configuration

### Environment Variables

Edit `.env` file:

```bash
# Database
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/audiomind

# OpenAI API Key
OPENAI_API_KEY=sk-your-key-here

# Hugging Face Token (for pyannote models)
HUGGINGFACE_TOKEN=hf_your-token-here

# Model Settings
WHISPER_MODEL=large-v3  # or base, small, medium, large
DEVICE=cpu  # or cuda

# Processing
MAX_CHUNK_DURATION=30
VAD_THRESHOLD=0.5
```

### Getting API Keys

#### OpenAI API Key
1. Go to https://platform.openai.com/
2. Sign up or log in
3. Navigate to API Keys
4. Create new secret key

#### Hugging Face Token
1. Go to https://huggingface.co/
2. Sign up or log in
3. Go to Settings > Access Tokens
4. Create new token with read permissions
5. Accept pyannote model license at:
   - https://huggingface.co/pyannote/speaker-diarization-3.1
   - https://huggingface.co/pyannote/segmentation-3.0

## Database Setup

### Using Docker

```bash
# Start PostgreSQL using docker-compose
docker-compose up postgres -d

# Run migrations
alembic upgrade head
```

### Using Local PostgreSQL

```bash
# Create database
createdb audiomind

# Or using psql
psql -U postgres
CREATE DATABASE audiomind;
\q

# Run migrations
alembic upgrade head
```

## Running the Service

### Development Mode

```bash
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000
```

### Production Mode

```bash
uvicorn app.main:app --host 0.0.0.0 --port 8000 --workers 4
```

### Using Docker

```bash
# Build and start all services
docker-compose up --build

# Start in background
docker-compose up -d

# View logs
docker-compose logs -f ai-service

# Stop services
docker-compose down
```

## Testing

### Test API Endpoints

```bash
# Make sure service is running
python test_api.py
```

### Manual Testing with curl

```bash
# Health check
curl http://localhost:8000/health

# Process audio
curl -X POST http://localhost:8000/api/process \
  -H "Content-Type: application/json" \
  -d '{"audio_path": "uploads/meeting.wav"}'

# Get transcript
curl http://localhost:8000/api/meeting/1/transcript

# Get analysis
curl http://localhost:8000/api/meeting/1/analysis
```

## Model Downloads

When you first run the service, it will automatically download:

1. **Whisper** (~2.9 GB for large-v3)
2. **Pyannote** (~300 MB)

This may take some time depending on your internet connection.

## GPU Support

To use GPU acceleration:

1. Install PyTorch with CUDA:
   ```bash
   pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

2. Set `DEVICE=cuda` in `.env`

3. Verify CUDA is available:
   ```python
   import torch
   print(torch.cuda.is_available())
   ```

## Troubleshooting

### FFmpeg not found
```bash
# Ubuntu/Debian
sudo apt-get install ffmpeg

# Mac
brew install ffmpeg

# Windows
# Download from https://ffmpeg.org/download.html
```

### Pyannote authentication error
Make sure you:
1. Have a valid Hugging Face token
2. Accepted the model license agreements
3. Set HUGGINGFACE_TOKEN in .env

### Out of memory
- Use smaller Whisper model (base, small, medium)
- Process shorter audio segments
- Reduce MAX_CHUNK_DURATION

## Integration with Spring Boot Services

The AI service is designed to work with your existing microservices:

- **meeting-service** (8081): Uploads audio files
- **processing-service** (8082): Calls AI service
- **ai-service** (8000): Processes audio

Make sure all services are running and can communicate.

## API Documentation

Once the service is running, visit:

- Swagger UI: http://localhost:8000/docs
- ReDoc: http://localhost:8000/redoc

## Support

For issues or questions, check the logs:

```bash
# View application logs
tail -f logs/app.log

# View Docker logs
docker-compose logs -f ai-service
```
