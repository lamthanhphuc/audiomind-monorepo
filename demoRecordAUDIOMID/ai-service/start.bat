@echo off
REM Start AI Service for Windows

echo Starting AudioMind AI Service...

REM Check if virtual environment exists
if not exist "venv" (
    echo Creating virtual environment...
    python -m venv venv
)

REM Activate virtual environment
call venv\Scripts\activate.bat

REM Install dependencies
echo Installing dependencies...
pip install -r requirements.txt

REM Create necessary directories
if not exist "storage\audio" mkdir storage\audio
if not exist "storage\temp" mkdir storage\temp
if not exist "logs" mkdir logs

REM Check if .env exists
if not exist ".env" (
    echo Warning: .env file not found!
    echo Please copy .env.example to .env and configure it
    pause
    exit /b 1
)

REM Run database migrations
echo Running database migrations...
alembic upgrade head

REM Start server
echo Starting FastAPI server...
uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
