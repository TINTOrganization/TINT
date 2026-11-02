FROM python:3.11-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/

ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1
RUN useradd --create-home worker
USER worker
# Consume media:uploads y procesa cada subida (ver src/media_worker/__main__.py).
# Servidor de salud interno (MEDIA_WORKER_PORT): 200 si el consumidor late.
EXPOSE 8088

HEALTHCHECK --interval=10s --timeout=5s --start-period=20s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f\"http://localhost:{os.environ.get('MEDIA_WORKER_PORT','8088')}/healthz\", timeout=2)" || exit 1

CMD ["python", "-m", "media_worker"]
