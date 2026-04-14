FROM python:3.10-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --upgrade pip && pip install --no-cache-dir -r requirements.txt

COPY app ./app

RUN groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 --create-home app \
	&& chown -R 10001:10001 /app

USER 10001

EXPOSE 8010

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8010"]
