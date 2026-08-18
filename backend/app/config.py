"""Application settings, read from the environment.

Connection details never live in the repository. Copy .env.example to .env and
fill it in; python-dotenv loads it in development, and the hosting platform
supplies the same variables in production.
"""
from __future__ import annotations

import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv

# Repository root: backend/app/config.py -> backend/ -> repo root
BACKEND_DIR = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_DIR.parent

load_dotenv(REPO_ROOT / ".env")
load_dotenv(BACKEND_DIR / ".env", override=False)


class ConfigError(RuntimeError):
    """Raised when required connection settings are missing or malformed."""


@dataclass(frozen=True)
class Settings:
    uri: str
    user: str
    password: str
    database: str | None
    max_pool_size: int
    #  Built frontend, served by FastAPI so the whole app is one deployable.
    static_dir: Path

    @property
    def safe_uri(self) -> str:
        """The URI with the instance id masked, safe to log or return in errors."""
        if "://" not in self.uri:
            return "<malformed uri>"
        scheme, rest = self.uri.split("://", 1)
        host = rest.split(".", 1)[-1] if "." in rest else rest
        return f"{scheme}://<instance>.{host}"


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    uri = os.getenv("COGNODB_URI", "").strip()
    password = os.getenv("COGNODB_PASSWORD", "").strip()

    if not uri or not password:
        raise ConfigError(
            "COGNODB_URI and COGNODB_PASSWORD must be set. Copy .env.example to "
            ".env and fill in the details from your CognoDB instance."
        )

    return Settings(
        uri=uri,
        user=os.getenv("COGNODB_USER", "cognodb").strip(),
        password=password,
        database=os.getenv("COGNODB_DATABASE") or None,
        max_pool_size=int(os.getenv("COGNODB_MAX_POOL_SIZE", "10")),
        static_dir=Path(os.getenv("STATIC_DIR", REPO_ROOT / "frontend" / "out")),
    )
