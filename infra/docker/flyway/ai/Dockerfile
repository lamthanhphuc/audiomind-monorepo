FROM python:3.10-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

COPY demoRecordAUDIOMID/ai-service/requirements.txt demoRecordAUDIOMID/ai-service/constraints.txt ./
RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -c constraints.txt -r requirements.txt

COPY demoRecordAUDIOMID/ai-service/ .

ENTRYPOINT ["alembic"]
CMD ["upgrade", "head"]
