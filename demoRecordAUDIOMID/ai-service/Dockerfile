FROM python:3.10-slim

WORKDIR /app

RUN if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
    sed -i 's|http://deb.debian.org/debian$|http://ftp.us.debian.org/debian|' /etc/apt/sources.list.d/debian.sources; \
    fi && \
    printf '%s\n' 'Acquire::Retries "5";' 'Acquire::http::Timeout "30";' 'Acquire::ftp::Timeout "30";' > /etc/apt/apt.conf.d/99-retries && \
    apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    git \
    build-essential \
    python3-dev \
    gosu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt constraints.txt ./

RUN pip install --no-cache-dir --upgrade pip setuptools==68.2.2 wheel \
    && pip install --no-cache-dir torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 \
        --index-url https://download.pytorch.org/whl/cu121 \
    && pip install --no-cache-dir --no-deps --no-build-isolation openai-whisper==20231117 \
    && pip install --no-cache-dir -c constraints.txt -r requirements.txt

COPY . .

RUN mkdir -p storage/audio storage/temp logs

RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --create-home app \
    && chown -R 10001:10001 /app

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER root

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]