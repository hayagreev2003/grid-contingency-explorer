# Two stages, because the frontend needs Node to build and the backend needs
# Python to run. The final image carries only the Python runtime plus the static
# files Next.js emitted — no Node, no node_modules.

# ---------- stage 1: build the static frontend ----------
FROM node:20-slim AS frontend

WORKDIR /build
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci

COPY frontend/ ./
# Empty API base: the backend serves these files, so the API is same-origin.
ENV NEXT_PUBLIC_API_BASE=""
RUN npm run build


# ---------- stage 2: the application ----------
FROM python:3.12-slim AS app

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1

WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
COPY --from=frontend /build/out ./static

# Tell the app where the built frontend landed. Everything else — the CognoDB
# URI, user and password — comes from the host's environment at runtime and is
# never baked into the image.
ENV STATIC_DIR=/app/static

# Render (and most hosts) inject $PORT. Default to 8000 for local `docker run`.
ENV PORT=8000
EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT}"]
