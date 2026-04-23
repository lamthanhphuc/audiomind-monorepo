FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip setuptools==68.2.2 wheel \
    && pip install --no-cache-dir torch==2.5.1 --index-url https://download.pytorch.org/whl/cpu \
    && pip install --no-cache-dir -r requirements.txt \
    && pip install --no-cache-dir setuptools==68.2.2 \
    && pip install --no-cache-dir --no-build-isolation openai-whisper==20231117

COPY app ./app

RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --create-home app \
    && chown -R 10001:10001 /app

USER 10001

EXPOSE 8011

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8011"]
