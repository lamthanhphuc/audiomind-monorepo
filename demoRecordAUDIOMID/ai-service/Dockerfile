FROM python:3.10

WORKDIR /app

RUN apt-get update && apt-get install -y \
    ffmpeg \
    git \
    build-essential \
    python3-dev \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .

RUN pip install --upgrade pip
RUN pip install --no-cache-dir setuptools==68.2.2 wheel

# ✅ Cài torch GPU trước (QUAN TRỌNG)
RUN pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
    --index-url https://download.pytorch.org/whl/cu121

# ✅ Cài whisper KHÔNG deps để tránh conflict
RUN pip install --no-cache-dir --no-deps --no-build-isolation openai-whisper==20231117

RUN pip install --no-cache-dir -r requirements.txt

COPY . .

RUN mkdir -p storage/audio storage/temp logs

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]