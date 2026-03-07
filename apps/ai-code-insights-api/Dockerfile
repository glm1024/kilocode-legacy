FROM python:3.12-slim AS base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

RUN pip install --no-cache-dir uv

COPY pyproject.toml ./
COPY app ./app
RUN uv pip install --system .

COPY alembic.ini ./alembic.ini
COPY alembic ./alembic

EXPOSE 18080

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18080"]
