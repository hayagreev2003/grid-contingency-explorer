"""The six endpoints the UI calls.

Route handlers stay thin on purpose: parse and validate input, run one named
query from ``app.queries``, shape the result. All error handling is centralised
in ``app.main`` so that "database unreachable" has exactly one representation.
"""
from __future__ import annotations

from fastapi import APIRouter, Query

from app import queries as q
from app.db import read_query, verify_connectivity
from app.models import (
    ContingencyResponse,
    CriticalLinesResponse,
    FuelMixResponse,
    HealthResponse,
    SupplyPathResponse,
    Topology,
)

router = APIRouter(prefix="/api", tags=["grid"])

RENEWABLE = {"solar", "wind", "hydro"}

# The base network never changes while the process runs, and rebuilding it costs
# ~1.7 s of round trips against the free tier. Cached in memory and cleared only
# by a restart, which is also what a re-seed requires.
_topology_cache: Topology | None = None
# Same reasoning for the corridor ranking: it is stored on the relationships at
# seed time and cannot change until the graph is re-seeded.
_critical_cache: dict[int, CriticalLinesResponse] = {}


def _tripped(raw: str | None) -> list[str]:
    """Parse the comma-separated outage set without trusting its shape."""
    if not raw:
        return []
    ids = [part.strip() for part in raw.split(",")]
    return [i for i in ids if i][:200]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    await verify_connectivity()
    rows = await read_query(q.COUNTS)
    counts = rows[0] if rows else {
        "substations": 0, "lines": 0, "plants": 0, "load_centres": 0
    }
    return HealthResponse(status="ok", counts={k: int(v) for k, v in counts.items()})


@router.get("/topology", response_model=Topology, response_model_by_alias=True)
async def topology() -> Topology:
    """Everything the map needs to draw the base network."""
    global _topology_cache
    if _topology_cache is None:
        substations = await read_query(q.TOPOLOGY_NODES)
        lines = await read_query(q.TOPOLOGY_LINES)
        load_centres = await read_query(q.TOPOLOGY_LOAD_CENTRES)
        _topology_cache = Topology(
            substations=substations, lines=lines, load_centres=load_centres
        )
    return _topology_cache


@router.get("/contingency", response_model=ContingencyResponse)
async def contingency(
    tripped: str | None = Query(None, description="Comma-separated line ids that are out"),
) -> ContingencyResponse:
    """Q3 - the capacity position of every city, plus the strict islanding check.

    Both are returned because they answer different questions and the honest
    headline needs both.
    """
    out = _tripped(tripped)
    cities = await read_query(q.ADEQUACY, tripped=out)
    at_risk = [row for row in cities if row["at_risk"]]

    # The islanding check walks to depth 6 and costs ~4.4 s on the free tier, so
    # it only runs when it can possibly return something. A fully islanded city
    # has zero deliverable capacity, which is necessarily below its peak demand,
    # so the islanded set is a strict subset of the at-risk set: if nothing is
    # short, nothing can be islanded.
    islanded = await read_query(q.ISLANDED, tripped=out) if at_risk else []
    return ContingencyResponse(
        tripped=out,
        cities=cities,
        at_risk=at_risk,
        islanded=islanded,
        shortfall_mw=sum(row["shortfall_mw"] for row in at_risk),
        demand_at_risk_mw=sum(row["demand_mw"] for row in at_risk),
        population_at_risk=sum(row["population"] for row in at_risk),
        total_demand_mw=sum(row["demand_mw"] for row in cities),
    )


@router.get("/path", response_model=SupplyPathResponse)
async def supply_paths(
    loadId: str = Query(..., min_length=1, max_length=64),
    tripped: str | None = None,
    maxHops: int = Query(q.PATH_HOPS, ge=1, le=q.PATH_HOPS),
    limit: int = Query(25, ge=1, le=100),
) -> SupplyPathResponse:
    """Q1 + Q2 - surviving routes into one city, with the weakest link on each."""
    out = _tripped(tripped)
    paths = await read_query(
        q.SUPPLY_PATHS, loadId=loadId, tripped=out, maxHops=maxHops, limit=limit
    )
    return SupplyPathResponse(
        loadId=loadId,
        maxHops=maxHops,
        tripped=out,
        paths=paths,
        deliverable_mw=sum(p["deliverable_mw"] for p in paths),
    )


@router.get("/mix", response_model=FuelMixResponse)
async def fuel_mix(
    loadId: str = Query(..., min_length=1, max_length=64),
    tripped: str | None = None,
    maxHops: int = Query(q.PATH_HOPS, ge=1, le=q.PATH_HOPS),
) -> FuelMixResponse:
    """Q5 - the generation mix a city can still be supplied from."""
    out = _tripped(tripped)
    mix = await read_query(q.FUEL_MIX, loadId=loadId, tripped=out, maxHops=maxHops)

    total = sum(row["reachable_mw"] for row in mix)
    renewable = sum(row["reachable_mw"] for row in mix if row["fuel"] in RENEWABLE)
    return FuelMixResponse(
        loadId=loadId,
        maxHops=maxHops,
        mix=mix,
        total_mw=total,
        renewable_mw=renewable,
        renewable_pct=round(100 * renewable / total, 1) if total else 0.0,
    )


@router.get("/critical", response_model=CriticalLinesResponse)
async def critical_lines(
    limit: int = Query(15, ge=1, le=50),
) -> CriticalLinesResponse:
    """Q4 - corridors ranked by the generation capacity routed through them."""
    if limit not in _critical_cache:
        lines = await read_query(q.CRITICAL_LINES, limit=limit)
        _critical_cache[limit] = CriticalLinesResponse(lines=lines)
    return _critical_cache[limit]
