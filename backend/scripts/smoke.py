"""Runs every application query against the live instance and prints one line per
query. Use it after seeding to confirm the graph answers correctly before
touching the UI:

    python -m scripts.smoke
"""
from __future__ import annotations

import argparse
import sys
import time
from typing import Any

from neo4j import GraphDatabase

from app import queries as q
from app.config import ConfigError, get_settings


def main() -> int:
    parser = argparse.ArgumentParser(description="Run every query against the live instance.")
    parser.add_argument(
        "--live",
        "--live-q4",
        dest="live",
        action="store_true",
        help=(
            "also run the reference live-traversal forms of Q4 and Q3b "
            "(slow; both exceed the statement deadline on the free tier)"
        ),
    )
    args = parser.parse_args()

    try:
        settings = get_settings()
    except ConfigError as exc:
        print(f"\n{exc}\n", file=sys.stderr)
        return 1

    driver = GraphDatabase.driver(settings.uri, auth=(settings.user, settings.password))
    try:
        with driver.session(
            database=settings.database, default_access_mode="READ"
        ) as session:
            print(f"\nSmoke test against {settings.safe_uri}\n")

            def run(label: str, cypher: str, **params: Any) -> list[dict]:
                started = time.perf_counter()
                rows = session.execute_read(lambda tx: tx.run(cypher, **params).data())
                elapsed = (time.perf_counter() - started) * 1000
                print(f"  {label:<28}{len(rows):>4} rows  {elapsed:.0f} ms")
                return rows

            counts = run("counts", q.COUNTS)[0]
            print(f"    {counts}")

            crit = run("critical lines (Q4)", q.CRITICAL_LINES, limit=5)
            if args.live:
                run("critical lines (Q4 live)", q.CRITICAL_LINES_LIVE, limit=5)
            base = run("adequacy, no outage (Q3)", q.ADEQUACY, tripped=[])
            print(
                f"    -> {sum(1 for r in base if r['at_risk'])} cities short of peak demand at rest"
            )
            # Q3b is computed in-process from the cached topology, not queried:
            # the traversal form below is combinatorial in the mesh and the free
            # tier answers it with OutOfTimeError. See app.routers.grid._islanded.
            if args.live:
                run("islanding check (Q3b live)", q.ISLANDED_LIVE, tripped=[])

            worst_id = crit[0]["line_id"] if crit else None
            if worst_id:
                hit = run(f"adequacy, {worst_id} out (Q3)", q.ADEQUACY, tripped=[worst_id])
                risk = [r for r in hit if r["at_risk"]]
                if risk:
                    print(
                        f"    -> {len(risk)} cities fall short, worst: "
                        f"{risk[0]['load_centre']} ({risk[0]['shortfall_mw']:.0f} MW)"
                    )
                else:
                    print("    -> network stays adequate for that corridor")

            run(
                "supply paths (Q1+Q2)", q.SUPPLY_PATHS,
                loadId="BENGALURU", tripped=[], maxHops=q.PATH_HOPS, limit=10,
            )
            run("fuel mix (Q5)", q.FUEL_MIX, loadId="BENGALURU", tripped=[], maxHops=q.PATH_HOPS)
            print("\nAll queries returned.\n")
    except Exception as exc:  # noqa: BLE001
        print(f"\nSmoke test failed: {exc}\n", file=sys.stderr)
        return 1
    finally:
        driver.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
