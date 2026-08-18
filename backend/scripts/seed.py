"""Idempotent seed loader.

    python -m scripts.seed            # MERGE everything; safe to re-run
    python -m scripts.seed --reset    # wipe the graph first, then load

Everything goes in through UNWIND-batched, parameterised statements. Nothing is
interpolated into Cypher, and batches are small because the free c0 tier has
256 MB of RAM and will not thank you for a 10,000-row transaction.
"""
from __future__ import annotations

import argparse
import sys
from typing import Any, Iterable, Sequence

from neo4j import GraphDatabase
from neo4j.exceptions import Neo4jError

from app.config import ConfigError, get_settings
from scripts.dataset import compute_corridor_load, generate_lines, load_dataset

BATCH = 250

REGIONS = [
    {"code": "NR", "name": "Northern Region"},
    {"code": "WR", "name": "Western Region"},
    {"code": "SR", "name": "Southern Region"},
    {"code": "ER", "name": "Eastern Region"},
    {"code": "NER", "name": "North-Eastern Region"},
]

# Constraints and indexes are Neo4j DDL, not part of openCypher. If CognoDB
# rejects them we carry on: every write below uses MERGE on the natural key, so
# the load stays idempotent either way -- it is only slower without the index.
SCHEMA = [
    "CREATE CONSTRAINT substation_id IF NOT EXISTS FOR (s:Substation) REQUIRE s.id IS UNIQUE",
    "CREATE CONSTRAINT plant_id      IF NOT EXISTS FOR (p:Plant)      REQUIRE p.id IS UNIQUE",
    "CREATE CONSTRAINT load_id       IF NOT EXISTS FOR (l:LoadCentre) REQUIRE l.id IS UNIQUE",
    "CREATE CONSTRAINT state_name    IF NOT EXISTS FOR (s:State)      REQUIRE s.name IS UNIQUE",
    "CREATE INDEX line_id            IF NOT EXISTS FOR ()-[r:CONNECTS]-() ON (r.line_id)",
]

UPSERT_REGIONS = """
UNWIND $rows AS row
MERGE (r:Region {code: row.code})
SET r.name = row.name
"""

UPSERT_STATES = """
UNWIND $rows AS row
MERGE (s:State {name: row.name})
SET s.region = row.region
WITH s, row
MATCH (r:Region {code: row.region})
MERGE (s)-[:IN_REGION]->(r)
"""

UPSERT_SUBSTATIONS = """
UNWIND $rows AS row
MERGE (s:Substation {id: row.id})
SET s.name = row.name, s.voltage_kv = row.voltage_kv,
    s.lat = row.lat, s.lon = row.lon
WITH s, row
MATCH (st:State {name: row.state})
MERGE (s)-[:IN_STATE]->(st)
"""

UPSERT_PLANTS = """
UNWIND $rows AS row
MERGE (p:Plant {id: row.id})
SET p.name = row.name, p.fuel = row.fuel,
    p.capacity_mw = row.capacity_mw, p.cuf = row.cuf
WITH p, row
MATCH (s:Substation {id: row.substation})
MERGE (p)-[:INJECTS_AT]->(s)
WITH p, row
MATCH (st:State {name: row.state})
MERGE (p)-[:IN_STATE]->(st)
"""

UPSERT_LOAD_CENTRES = """
UNWIND $rows AS row
MERGE (l:LoadCentre {id: row.id})
SET l.name = row.name, l.peak_demand_mw = row.peak_demand_mw,
    l.population = row.population, l.lat = row.lat, l.lon = row.lon
WITH l, row
MATCH (s:Substation {id: row.substation})
MERGE (s)-[:SUPPLIES]->(l)
WITH l, row
MATCH (st:State {name: row.state})
MERGE (l)-[:IN_STATE]->(st)
"""

UPSERT_LINES = """
UNWIND $rows AS row
MATCH (a:Substation {id: row.from}), (b:Substation {id: row.to})
MERGE (a)-[r:CONNECTS {line_id: row.line_id}]->(b)
SET r.name = row.name, r.capacity_mw = row.capacity_mw,
    r.voltage_kv = row.voltage_kv, r.length_km = row.length_km,
    r.status = row.status, r.hvdc = row.hvdc,
    r.mw_carried = row.mw_carried, r.paths_carried = row.paths_carried
"""

COUNTS = """
MATCH (s:Substation) WITH count(s) AS substations
MATCH (p:Plant)      WITH substations, count(p) AS plants
MATCH (l:LoadCentre) WITH substations, plants, count(l) AS load_centres
MATCH ()-[r:CONNECTS]->()
RETURN substations, plants, load_centres, count(r) AS lines
"""


def _chunks(rows: Sequence[dict], size: int) -> Iterable[Sequence[dict]]:
    for i in range(0, len(rows), size):
        yield rows[i : i + size]


def _run(session, cypher: str, **params: Any):
    return session.execute_write(lambda tx: tx.run(cypher, **params).data())


def _run_batched(session, label: str, cypher: str, rows: Sequence[dict]) -> None:
    done = 0
    for batch in _chunks(rows, BATCH):
        _run(session, cypher, rows=list(batch))
        done += len(batch)
        print(f"\r  {label}: {done}/{len(rows)}", end="", flush=True)
    print(f"\r  {label}: {len(rows)}/{len(rows)}")


def _apply_schema(session) -> None:
    applied = 0
    for statement in SCHEMA:
        try:
            _run(session, statement)
            applied += 1
        except Neo4jError:
            head = " ".join(statement.split()[:3])
            print(f"  skipped (unsupported by this server): {head}...")
    print(f"  schema: {applied}/{len(SCHEMA)} statements applied")


def main() -> int:
    parser = argparse.ArgumentParser(description="Seed the grid graph.")
    parser.add_argument("--reset", action="store_true", help="wipe the graph first")
    args = parser.parse_args()

    try:
        settings = get_settings()
    except ConfigError as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        return 1

    data = load_dataset()
    generated = generate_lines()

    # The corridor ranking is a pure function of the topology and does not change
    # with the outage set, so it is computed here and stored on the relationship
    # rather than traversed on every request. See compute_corridor_load().
    corridor_load = compute_corridor_load(generated)
    lines = []
    for line in generated:
        row = line.as_row()
        row.update(corridor_load[line.line_id])
        lines.append(row)

    states = sorted(
        {
            row["state"]
            for group in ("substations", "plants", "load_centres")
            for row in data[group]
        }
    )
    state_rows = [
        {"name": name, "region": data["state_region"].get(name, "NR")} for name in states
    ]

    driver = GraphDatabase.driver(
        settings.uri,
        auth=(settings.user, settings.password),
        max_connection_pool_size=5,
        connection_timeout=15.0,
    )
    try:
        try:
            driver.verify_connectivity()
        except Exception as exc:  # noqa: BLE001
            print(
                "Could not reach CognoDB. Check COGNODB_URI, the password, and that "
                f"the instance is running.\n  {exc}",
                file=sys.stderr,
            )
            return 1

        print(f"Connected to {settings.safe_uri}\n")
        with driver.session(database=settings.database) as session:
            if args.reset:
                print("Resetting graph...")
                # Delete in slices so a large graph cannot blow the heap.
                while True:
                    rows = _run(
                        session,
                        "MATCH (n) WITH n LIMIT 5000 DETACH DELETE n RETURN count(n) AS deleted",
                    )
                    if not rows or rows[0]["deleted"] == 0:
                        break

            print("Applying schema...")
            _apply_schema(session)

            print("Loading nodes...")
            _run_batched(session, "regions", UPSERT_REGIONS, REGIONS)
            _run_batched(session, "states", UPSERT_STATES, state_rows)
            _run_batched(session, "substations", UPSERT_SUBSTATIONS, data["substations"])
            _run_batched(session, "plants", UPSERT_PLANTS, data["plants"])
            _run_batched(session, "load centres", UPSERT_LOAD_CENTRES, data["load_centres"])

            print("Loading transmission corridors...")
            _run_batched(session, "lines", UPSERT_LINES, lines)

            counts = _run(session, COUNTS)[0]
            print(
                f"\nDone. {counts['substations']} substations, {counts['lines']} lines, "
                f"{counts['plants']} plants, {counts['load_centres']} load centres."
            )
    finally:
        driver.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
