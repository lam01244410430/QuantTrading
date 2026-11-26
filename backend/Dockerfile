ARG PYTHON_IMAGE=python:3.12-slim
FROM ${PYTHON_IMAGE} AS runtime
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app

COPY backend/requirements.txt backend/requirements.txt
RUN python -m pip install --no-cache-dir -r backend/requirements.txt
COPY quanttrading quanttrading
COPY fixtures/fixture_v1_basic.csv fixtures/fixture_v1_basic.csv
COPY backend backend
USER 10001:10001

FROM runtime AS test
USER root
COPY requirements-dev.txt requirements-dev.txt
RUN python -m pip install --no-cache-dir -r requirements-dev.txt
USER 10001:10001
