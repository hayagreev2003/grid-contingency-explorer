"""Bolt driver lifecycle and the single read helper every query goes through."""
from __future__ import annotations

import logging
from typing import Any

from neo4j import AsyncDriver, AsyncGraphDatabase
from neo4j.exceptions import (
    AuthError,
    ConfigurationError,
    Neo4jError,
    ServiceUnavailable,
    TransientError,
)

from app.config import ConfigError, get_settings

log = logging.getLogger("grid.db")

# One driver for the whole process. The driver is a connection pool, not a
# connection: creating one per request would exhaust the free tier's 200
# connection ceiling under very little load.
_driver: AsyncDriver | None = None


class DatabaseUnreachable(RuntimeError):
    """The database is not there. Distinct from 'the query was wrong'."""


class QueryDeadlineExceeded(RuntimeError):
    """The server abandoned the statement before finishing it.

    CognoDB reports this as Neo.TransientError.General.OutOfTimeError, "context
    deadline exceeded". The database is healthy and the query is valid: it was
    too expensive for the instance to finish, which is a capacity answer, not a
    fault. It gets its own class so the UI can say so and offer a retry rather
    than showing "query failed" for something that is only slow.
    """


def get_driver() -> AsyncDriver:
    global _driver
    if _driver is None:
        settings = get_settings()
        _driver = AsyncGraphDatabase.driver(
            settings.uri,
            auth=(settings.user, settings.password),
            max_connection_pool_size=settings.max_pool_size,
            connection_acquisition_timeout=10.0,
            connection_timeout=10.0,
            max_transaction_retry_time=8.0,
        )
    return _driver


async def close_driver() -> None:
    global _driver
    if _driver is not None:
        await _driver.close()
        _driver = None


async def verify_connectivity() -> None:
    """Cheap liveness probe. Raises DatabaseUnreachable on any connection fault."""
    try:
        await get_driver().verify_connectivity()
    except Exception as exc:  # noqa: BLE001 - reclassified below
        raise _as_unreachable(exc) from exc


async def read_query(cypher: str, /, **params: Any) -> list[dict[str, Any]]:
    """Run a read-only statement with bound parameters and return plain dicts.

    Every caller passes parameters as keyword arguments. There is no code path in
    this application that interpolates a value into a Cypher string.
    """
    settings = get_settings()
    driver = get_driver()
    try:
        async with driver.session(
            database=settings.database, default_access_mode="READ"
        ) as session:
            result = await session.run(cypher, **params)
            return [record.data() async for record in result]
    except (ServiceUnavailable, AuthError, ConfigurationError, OSError) as exc:
        raise _as_unreachable(exc) from exc
    except TransientError as exc:
        if "OutOfTimeError" in str(exc.code or "") or "deadline" in str(exc):
            raise QueryDeadlineExceeded(str(exc)) from exc
        raise
    except Neo4jError:
        # A real query error: surface it as a 500 and log the detail.
        raise


def _as_unreachable(exc: Exception) -> Exception:
    """Classify a failure as 'database not reachable' where that is what it means."""
    if isinstance(exc, (ServiceUnavailable, AuthError, ConfigurationError, OSError)):
        return DatabaseUnreachable(str(exc))
    message = str(exc)
    if any(
        marker in message
        for marker in (
            "Unable to retrieve routing information",
            "Could not perform discovery",
            "Connection acquisition timed out",
            "Name or service not known",
            "Temporary failure in name resolution",
        )
    ):
        return DatabaseUnreachable(message)
    return exc


__all__ = [
    "ConfigError",
    "DatabaseUnreachable",
    "QueryDeadlineExceeded",
    "close_driver",
    "get_driver",
    "read_query",
    "verify_connectivity",
]
