"""FastAPI application: API under /api, the built frontend at everything else.

Serving the static export from the same process keeps this a single deployable
with a single origin -- no CORS, one URL for the hosted demo.
"""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import ConfigError, get_settings
from app.db import DatabaseUnreachable, close_driver, verify_connectivity
from app.routers import grid

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s"
)
log = logging.getLogger("grid")


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Probe the database at startup, but never refuse to boot because of it.

    A failed probe is logged and the app still serves: the UI then renders its
    'database unreachable' state with a retry, which is far more useful than a
    container that crash-loops out of sight.
    """
    try:
        await verify_connectivity()
        log.info("connected to %s", get_settings().safe_uri)
    except ConfigError as exc:
        log.error("configuration incomplete: %s", exc)
    except DatabaseUnreachable as exc:
        log.warning("database unreachable at startup, serving anyway: %s", exc)
    yield
    await close_driver()


app = FastAPI(
    title="Grid Contingency Explorer",
    description=(
        "Trip a transmission corridor and see which Indian cities can no longer "
        "be supplied to their peak demand. Backed by CognoDB over Bolt."
    ),
    version="1.0.0",
    lifespan=lifespan,
)

# In production the frontend is served by this same process, so requests are
# same-origin and CORS is irrelevant. It exists for development, where `next dev`
# runs on :3000 and uvicorn on :8000. Origins are explicit, never a wildcard.
_dev_origins = os.getenv(
    "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
).split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins=[o.strip() for o in _dev_origins if o.strip()],
    allow_methods=["GET"],
    allow_headers=["*"],
)

app.include_router(grid.router)


# --------------------------------------------------------------- error handling
#
# Three outcomes, three status codes, one shape: {"error": str, "unreachable": bool}
#   503  the database is not there, or is not configured -> UI offers a retry
#   422  the request was malformed (FastAPI's own validation)
#   500  the query broke -> logged in full, generic message to the client


@app.exception_handler(DatabaseUnreachable)
async def _unreachable(request: Request, exc: DatabaseUnreachable) -> JSONResponse:
    log.warning("unreachable on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=503,
        content={
            "error": (
                "The grid database is unreachable. Check that the CognoDB "
                "instance is running and the connection details are correct."
            ),
            "unreachable": True,
        },
    )


@app.exception_handler(ConfigError)
async def _misconfigured(request: Request, exc: ConfigError) -> JSONResponse:
    log.error("configuration error on %s: %s", request.url.path, exc)
    return JSONResponse(
        status_code=503, content={"error": str(exc), "unreachable": True}
    )


@app.exception_handler(RequestValidationError)
async def _invalid(request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(
        status_code=422,
        content={"error": "Invalid request parameters.", "unreachable": False},
    )


@app.exception_handler(Exception)
async def _unhandled(request: Request, exc: Exception) -> JSONResponse:
    log.exception("query failed on %s", request.url.path)
    return JSONResponse(
        status_code=500,
        content={"error": "Query failed. See server logs for details.", "unreachable": False},
    )


# ------------------------------------------------------------- static frontend

def mount_frontend(app: FastAPI) -> None:
    """Mount the built frontend if it exists.

    Kept optional so the API can run on its own during development, when
    `next dev` serves the UI and proxies /api here.
    """
    try:
        static_dir = get_settings().static_dir
    except ConfigError:
        return
    if not static_dir.is_dir():
        log.info("no built frontend at %s - serving API only", static_dir)
        return

    assets = static_dir / "_next"
    if assets.is_dir():
        app.mount("/_next", StaticFiles(directory=assets), name="next-assets")

    @app.get("/{full_path:path}", include_in_schema=False)
    async def spa(full_path: str) -> FileResponse:
        candidate = static_dir / full_path
        if full_path and candidate.is_file():
            return FileResponse(candidate)
        return FileResponse(static_dir / "index.html")

    log.info("serving frontend from %s", static_dir)


mount_frontend(app)
