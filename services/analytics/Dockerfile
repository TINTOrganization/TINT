FROM python:3.11-slim

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY src/ ./src/

ENV PYTHONPATH=/app/src PYTHONUNBUFFERED=1
RUN useradd --create-home worker
USER worker

# API de solo lectura de KPIs (ANALYTICS_PORT).
EXPOSE 8084

# Liveness del proceso y de la API (ADR 0021); no consulta PostgreSQL ni Redis.
HEALTHCHECK --interval=10s --timeout=5s --start-period=20s \
  CMD python -c "import os, urllib.request; urllib.request.urlopen(f\"http://localhost:{os.environ.get('ANALYTICS_PORT','8084')}/healthz\", timeout=2)" || exit 1

CMD ["python", "-m", "analytics"]
