#!/usr/bin/env bash
# Development: FastAPI with reload on :8000, Next dev server on :3000.
# For a production-like run, build the frontend and let FastAPI serve it:
#   cd frontend && npm run build && cd ../backend && ./.venv/bin/uvicorn app.main:app
set -euo pipefail
cd "$(dirname "$0")"

trap 'kill 0' EXIT
(cd backend && ./.venv/bin/uvicorn app.main:app --reload --port 8000) &
(cd frontend && NEXT_PUBLIC_API_BASE=http://localhost:8000 npm run dev) &
wait
