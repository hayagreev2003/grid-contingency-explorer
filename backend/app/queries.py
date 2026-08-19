"""Every Cypher statement the application runs, named and commented.

Three conventions hold throughout:

 1. Nothing is interpolated. All user input arrives as bound parameters. The one
    thing Cypher genuinely cannot parameterise is the upper bound of a
    variable-length pattern (``*0..$n`` is a syntax error), so the bound is a
    literal and the caller narrows it with ``length(p) <= $maxHops``.

    The only Cypher assembled from strings is the composition of the module
    constants below (``_BOTTLENECK``, ``_SURVIVING``) into the statements. Those
    are fixed source text, never request data: no value that arrives over HTTP
    reaches a query except as a bound parameter.

 2. ``CONNECTS`` is stored in one direction but always traversed undirected
    (``-[c:CONNECTS*0..5]-``), because power flows either way along a line.

 3. Capacity, not just connectivity. An early version of this app asked "can any
    generator still reach this city" -- with generation at 44 of 112
    substations, the answer was yes for every single- and double-line outage in
    the network, so the query never said anything. The questions below ask how
    much capacity can be delivered instead, which is both the physically
    meaningful question and a discriminating one.

HONEST LIMIT, stated here and in the README: deliverable capacity is computed as
the sum over reachable plants of min(plant capacity, widest-path bottleneck).
Corridors shared by several plants are therefore counted more than once, which
makes the figure an UPPER BOUND on what could be delivered -- a screening
heuristic, not an AC load flow. It ranks and compares correctly; it does not
predict real dispatch.
"""
from __future__ import annotations

#: Depth limit for path/mix queries. Must match the literal in the patterns.
PATH_HOPS = 5
#: Depth used for the network-wide adequacy sweep. Kept short: it runs per city.
ADEQUACY_HOPS = 3

# ---------------------------------------------------------------------------
# CognoDB dialect notes, established by probing the live instance rather than
# assumed. CognoDB speaks openCypher but is not Neo4j, and three things differ:
#
#   1. A variable-length relationship variable (`-[c:CONNECTS*1..3]-`) is typed
#      as a Path, not a list. `all(r IN c ...)` and `size(c)` both fail with
#      "requires list, got *types.Path". Every query below therefore binds the
#      path (`MATCH p = ...`) and uses `relationships(p)` and `length(p)`.
#   2. `round()` takes one argument only; the two-argument precision form is a
#      SemanticError. Rounding to one decimal is done as round(x * 10) / 10.0.
#   3. The variable-length segment is matched as its own path so that
#      `relationships(p)` contains CONNECTS relationships and nothing else.
#      Mixing in an `INJECTS_AT` hop would make the status filter reject every
#      row, because that relationship has no `status` property.
#
# Everything else used here -- reduce, nodes(p) comprehensions, ordered
# collect()[0], reverse(), shortestPath, toInteger() in LIMIT -- was verified to
# work on CognoDB.
# ---------------------------------------------------------------------------

# Widest-path fold, shared by every capacity query.
#
# `reduce` walks the relationship list of a path taking the minimum capacity --
# the weakest link. Wrapping that in `max()` across all paths to the same plant
# gives the widest path: the best route capacity available. Max-of-min over a set
# of paths whose length is not known until the query runs is exactly the shape a
# relational schema cannot express without procedural code.
_BOTTLENECK = """reduce(m = 1000000.0, r IN relationships(p) |
  CASE WHEN r.capacity_mw IS NOT NULL AND r.capacity_mw < m THEN r.capacity_mw ELSE m END)"""

_SURVIVING = (
    "all(r IN relationships(p) "
    "WHERE r.status = 'IN_SERVICE' AND NOT r.line_id IN $tripped)"
)

# The adequacy sweep needs one path that ends at the plant, so that a city with
# no reachable generator still yields a row to aggregate. That path's last hop is
# an INJECTS_AT relationship, which has no `status` or `line_id` -- a busbar
# connection, not a line, and therefore always in service. The tolerant form
# treats a missing status as healthy instead of rejecting the whole path.
_SURVIVING_TOLERANT = (
    "all(r IN relationships(p) "
    "WHERE coalesce(r.status, 'IN_SERVICE') = 'IN_SERVICE' "
    "AND NOT coalesce(r.line_id, '') IN $tripped)"
)


# --------------------------------------------------------------------- topology

TOPOLOGY_NODES = """
MATCH (s:Substation)
OPTIONAL MATCH (s)-[:IN_STATE]->(st:State)
RETURN s.id         AS id,
       s.name       AS name,
       s.voltage_kv AS voltage_kv,
       s.lat        AS lat,
       s.lon        AS lon,
       st.name      AS state,
       st.region    AS region
ORDER BY s.name
"""

TOPOLOGY_LINES = """
MATCH (a:Substation)-[r:CONNECTS]->(b:Substation)
RETURN r.line_id     AS line_id,
       r.name        AS name,
       a.id          AS from,
       b.id          AS to,
       a.lat         AS from_lat,
       a.lon         AS from_lon,
       b.lat         AS to_lat,
       b.lon         AS to_lon,
       r.capacity_mw AS capacity_mw,
       r.voltage_kv  AS voltage_kv,
       r.length_km   AS length_km,
       r.status      AS status,
       coalesce(r.hvdc, false) AS hvdc
ORDER BY r.line_id
"""

TOPOLOGY_LOAD_CENTRES = """
MATCH (sub:Substation)-[:SUPPLIES]->(l:LoadCentre)-[:IN_STATE]->(st:State)
RETURN l.id              AS id,
       l.name            AS name,
       l.peak_demand_mw  AS peak_demand_mw,
       l.population      AS population,
       l.lat             AS lat,
       l.lon             AS lon,
       sub.id            AS substation,
       st.name           AS state
ORDER BY l.peak_demand_mw DESC
"""


# ------------------------------------------------- Q1 + Q2: route and bottleneck

# For every plant that can still deliver into one city: the best route to it and
# that route's weakest link.
#
# The ordered-`collect`-then-head idiom picks, per plant, the path with the
# highest bottleneck (tie-broken by fewest hops) and keeps the node names along
# it, so the UI can print the actual corridor sequence rather than just a number.
SUPPLY_PATHS = f"""
MATCH (sink:Substation)-[:SUPPLIES]->(:LoadCentre {{id: $loadId}})
MATCH (pl:Plant)-[:INJECTS_AT]->(src:Substation)
MATCH p = (sink)-[:CONNECTS*0..5]-(src)
WHERE {_SURVIVING} AND length(p) <= $maxHops
WITH pl,
     length(p)                   AS hops,
     [n IN nodes(p) | n.name]    AS route,
     {_BOTTLENECK}               AS bottleneck
ORDER BY bottleneck DESC, hops ASC
WITH pl, collect({{bottleneck: bottleneck, route: route, hops: hops}})[0] AS best
RETURN pl.name          AS plant,
       pl.fuel          AS fuel,
       pl.capacity_mw   AS plant_mw,
       best.hops        AS hop_count,
       [pl.name] + reverse(best.route) AS hops,
       CASE WHEN best.bottleneck >= 1000000.0 THEN null ELSE best.bottleneck END AS bottleneck_mw,
       best.bottleneck < pl.capacity_mw AS constrained,
       CASE WHEN best.bottleneck < pl.capacity_mw
            THEN best.bottleneck ELSE pl.capacity_mw END AS deliverable_mw
ORDER BY deliverable_mw DESC, hop_count ASC
LIMIT toInteger($limit)
"""


# --------------------------------------------------- Q3: adequacy under outage

# The headline query. For every city, sum the capacity that can still be
# delivered to it within ADEQUACY_HOPS given the current outage set, and report
# the ones that fall below their own peak demand.
#
# The OPTIONAL MATCH matters: a city with no surviving route to any generator at
# all produces no rows to aggregate, and `sum()` over an empty group returns 0,
# so a fully islanded city shows up as a total shortfall rather than vanishing
# from the result.
ADEQUACY = f"""
MATCH (sink:Substation)-[:SUPPLIES]->(l:LoadCentre)-[:IN_STATE]->(st:State)
OPTIONAL MATCH p = (sink)-[:CONNECTS*0..3]-(src:Substation)<-[:INJECTS_AT]-(pl:Plant)
WHERE {_SURVIVING_TOLERANT}
WITH l, st, pl, max({_BOTTLENECK}) AS widest
WITH l, st,
     sum(CASE WHEN pl IS NULL THEN 0
              WHEN pl.capacity_mw < widest THEN pl.capacity_mw
              ELSE widest END) AS deliverable_mw
RETURN l.id             AS id,
       l.name           AS load_centre,
       st.name          AS state,
       l.peak_demand_mw AS demand_mw,
       l.population     AS population,
       l.lat            AS lat,
       l.lon            AS lon,
       deliverable_mw,
       l.peak_demand_mw - deliverable_mw AS shortfall_mw,
       deliverable_mw < l.peak_demand_mw AS at_risk
ORDER BY shortfall_mw DESC
"""

# Every substation a plant injects into: the source set for the islanding check.
# Fixed by the topology, so the router caches it alongside the base network.
INJECTION_POINTS = """
MATCH (:Plant)-[:INJECTS_AT]->(s:Substation)
RETURN DISTINCT s.id AS id
"""

# Reference implementation of the strict islanding check as a live traversal.
#
# Correct, and not runnable on the free tier: `-[:CONNECTS*0..6]-` enumerates
# every path up to depth 6 from all 44 injection points across a 112-substation
# mesh, which is combinatorial rather than linear in the graph. CognoDB answers
# it with Neo.TransientError.General.OutOfTimeError -- the statement deadline,
# not a connection fault.
#
# Islanding is reachability, and reachability visits each node once. The router
# computes it with a breadth-first sweep over the cached topology instead
# (`_islanded`): exact, no depth cap, no round trip. This statement is kept
# because it states the question in Cypher, and is exercised by scripts.smoke
# with --live so the equivalence stays checkable.
ISLANDED_LIVE = f"""
MATCH (:Plant)-[:INJECTS_AT]->(src:Substation)
MATCH p = (src)-[:CONNECTS*0..6]-(reached:Substation)
WHERE {_SURVIVING}
WITH collect(DISTINCT reached) AS energised
MATCH (sink:Substation)-[:SUPPLIES]->(l:LoadCentre)
WHERE NOT sink IN energised
RETURN l.id AS id, l.name AS load_centre, l.peak_demand_mw AS demand_mw
ORDER BY demand_mw DESC
"""


# ------------------------------------------------- Q4: critical line ranking

# Corridors ranked by the generation capacity whose shortest route to a city runs
# through them -- a betweenness-centrality proxy weighted by MW, which is what
# pushes the HVDC bipoles to the top where they belong: they carry few routes but
# an enormous amount of power.
#
# This reads a property rather than traversing. The ranking is a pure function of
# the topology -- it does not depend on the outage set -- so it is computed once
# at seed time by scripts.dataset.compute_corridor_load() and stored on the
# relationship. The live traversal below is the reference implementation and is
# kept deliberately: Neo4j runs it in ~190 ms, but the CognoDB free tier (0.5
# vCPU) took 19 s and then began exceeding its statement deadline. Precomputing
# what cannot change is the honest fix; pretending the traversal was fast enough
# would not be.
CRITICAL_LINES = """
MATCH (a:Substation)-[r:CONNECTS]->(b:Substation)
WHERE r.mw_carried IS NOT NULL
RETURN r.line_id       AS line_id,
       r.name          AS line,
       r.capacity_mw   AS capacity_mw,
       r.mw_carried    AS mw_carried,
       r.paths_carried AS paths_carried
ORDER BY mw_carried DESC
LIMIT toInteger($limit)
"""

# Reference implementation of Q4 as a live traversal. Correct, and fast on a
# fuller-sized instance; too slow for the free tier. Exercised by scripts.smoke
# with --live so the equivalence stays checkable.
CRITICAL_LINES_LIVE = """
MATCH (pl:Plant)-[:INJECTS_AT]->(src:Substation)
MATCH (sink:Substation)-[:SUPPLIES]->(:LoadCentre)
// A substation can host both a plant and a city (North Chennai does).
// shortestPath refuses identical endpoints, and a zero-length route carries
// nothing anyway.
WHERE src <> sink
MATCH p = shortestPath( (src)-[:CONNECTS*1..8]-(sink) )
UNWIND relationships(p) AS r
RETURN r.line_id          AS line_id,
       r.name             AS line,
       r.capacity_mw      AS capacity_mw,
       sum(pl.capacity_mw) AS mw_carried,
       count(*)           AS paths_carried
ORDER BY mw_carried DESC
LIMIT toInteger($limit)
"""


# ----------------------------------------------------------- Q5: reachable mix

# The deliverable generation mix for one city under the current outages.
FUEL_MIX = f"""
MATCH (sink:Substation)-[:SUPPLIES]->(:LoadCentre {{id: $loadId}})
MATCH (pl:Plant)-[:INJECTS_AT]->(src:Substation)
MATCH p = (sink)-[:CONNECTS*0..5]-(src)
WHERE {_SURVIVING} AND length(p) <= $maxHops
WITH pl, max({_BOTTLENECK}) AS widest
WITH pl.fuel AS fuel,
     sum(CASE WHEN pl.capacity_mw < widest THEN pl.capacity_mw ELSE widest END) AS mw,
     count(pl) AS plant_count
WITH collect({{fuel: fuel, mw: mw, plant_count: plant_count}}) AS rows, sum(mw) AS total
UNWIND rows AS row
RETURN row.fuel        AS fuel,
       row.mw          AS reachable_mw,
       row.plant_count AS plant_count,
       CASE WHEN total = 0 THEN 0.0
            ELSE round(1000.0 * row.mw / total) / 10.0 END AS pct
ORDER BY reachable_mw DESC
"""


# ---------------------------------------------------------------------- health

COUNTS = """
MATCH (s:Substation) WITH count(s) AS substations
MATCH (p:Plant)      WITH substations, count(p) AS plants
MATCH (l:LoadCentre) WITH substations, plants, count(l) AS load_centres
MATCH ()-[r:CONNECTS]->()
RETURN substations, plants, load_centres, count(r) AS lines
"""
