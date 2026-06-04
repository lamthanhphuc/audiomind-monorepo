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

COPY requirements.txt requirements-offline.txt constraints.txt constraints-offline.txt ./

ARG INSTALL_OFFLINE_STT=false

RUN pip install --no-cache-dir --upgrade pip setuptools==80.9.0 wheel \
    && pip install --no-cache-dir -c constraints.txt -r requirements.txt \
    && if [ "$INSTALL_OFFLINE_STT" = "true" ]; then \
        pip install --no-cache-dir -c constraints-offline.txt -r requirements-offline.txt; \
    fi

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
