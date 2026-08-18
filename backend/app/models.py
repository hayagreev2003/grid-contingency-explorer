"""Response shapes. These are the contract the frontend types mirror."""
from __future__ import annotations

from pydantic import BaseModel, Field


class Substation(BaseModel):
    id: str
    name: str
    voltage_kv: int
    lat: float
    lon: float
    state: str | None = None
    region: str | None = None


class Line(BaseModel):
    line_id: str
    name: str
    from_: str = Field(alias="from")
    to: str
    from_lat: float
    from_lon: float
    to_lat: float
    to_lon: float
    capacity_mw: float
    voltage_kv: int
    length_km: float
    status: str
    hvdc: bool

    model_config = {"populate_by_name": True}


class LoadCentre(BaseModel):
    id: str
    name: str
    peak_demand_mw: float
    population: int
    lat: float
    lon: float
    substation: str
    state: str


class Topology(BaseModel):
    substations: list[Substation]
    lines: list[Line]
    load_centres: list[LoadCentre] = Field(serialization_alias="loadCentres")

    model_config = {"populate_by_name": True}


class SupplyPath(BaseModel):
    plant: str
    fuel: str
    plant_mw: float
    hops: list[str]
    hop_count: int
    bottleneck_mw: float | None
    constrained: bool
    deliverable_mw: float


class SupplyPathResponse(BaseModel):
    loadId: str
    maxHops: int
    tripped: list[str]
    paths: list[SupplyPath]
    deliverable_mw: float


class AdequacyRow(BaseModel):
    id: str
    load_centre: str
    state: str
    demand_mw: float
    population: int
    lat: float
    lon: float
    deliverable_mw: float
    shortfall_mw: float
    at_risk: bool


class IslandedRow(BaseModel):
    id: str
    load_centre: str
    demand_mw: float


class ContingencyResponse(BaseModel):
    tripped: list[str]
    cities: list[AdequacyRow]
    at_risk: list[AdequacyRow]
    islanded: list[IslandedRow]
    shortfall_mw: float
    demand_at_risk_mw: float
    population_at_risk: int
    total_demand_mw: float


class CriticalLine(BaseModel):
    line_id: str
    line: str
    capacity_mw: float
    mw_carried: float
    paths_carried: int


class CriticalLinesResponse(BaseModel):
    lines: list[CriticalLine]


class FuelMixRow(BaseModel):
    fuel: str
    reachable_mw: float
    plant_count: int
    pct: float


class FuelMixResponse(BaseModel):
    loadId: str
    maxHops: int
    mix: list[FuelMixRow]
    total_mw: float
    renewable_mw: float
    renewable_pct: float


class HealthResponse(BaseModel):
    status: str
    counts: dict[str, int]


class ApiError(BaseModel):
    error: str
    unreachable: bool = False
