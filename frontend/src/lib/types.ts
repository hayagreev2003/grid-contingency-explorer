/** Shared shapes between the Cypher layer, the route handlers and the UI. */

export type Fuel = 'coal' | 'lignite' | 'gas' | 'nuclear' | 'hydro' | 'solar' | 'wind'

export type RegionCode = 'NR' | 'WR' | 'SR' | 'ER' | 'NER'

export interface Substation {
  id: string
  name: string
  voltage_kv: number
  lat: number
  lon: number
  state: string
  region: RegionCode
}

export interface Line {
  line_id: string
  name: string
  from: string
  to: string
  capacity_mw: number
  voltage_kv: number
  length_km: number
  /** 'IN_SERVICE' | 'OUT_OF_SERVICE' — planned outages live in the seed data. */
  status: string
  hvdc: boolean
}

export interface Plant {
  id: string
  name: string
  fuel: Fuel
  capacity_mw: number
  /** Capacity utilisation factor, used to weight realistic availability. */
  cuf: number
  substation: string
  state: string
}

export interface LoadCentre {
  id: string
  name: string
  peak_demand_mw: number
  population: number
  substation: string
  state: string
  lat: number
  lon: number
}

/** Q1/Q2 — the best surviving route from a plant to a city, and its weakest link. */
export interface SupplyPath {
  plant: string
  fuel: Fuel
  plant_mw: number
  /** Substation names along the widest route, plant first. */
  hops: string[]
  hop_count: number
  /** Widest-path bottleneck in MW; null when the plant sits on the city's own bus. */
  bottleneck_mw: number | null
  constrained: boolean
  deliverable_mw: number
}

/** Q3 — a city's capacity position under the current outage set. */
export interface AdequacyRow {
  id: string
  load_centre: string
  state: string
  demand_mw: number
  population: number
  lat: number
  lon: number
  deliverable_mw: number
  shortfall_mw: number
  at_risk: boolean
}

/** Q3b — a city with no surviving path to any generator at all. */
export interface IslandedRow {
  id: string
  load_centre: string
  demand_mw: number
}

/** Q4 — corridors ranked by the generation capacity routed through them. */
export interface CriticalLine {
  line_id: string
  line: string
  capacity_mw: number
  mw_carried: number
  paths_carried: number
}

/** Q5 — deliverable generation mix for one load centre. */
export interface FuelMixRow {
  fuel: Fuel
  reachable_mw: number
  pct: number
  plant_count: number
}

export interface ApiError {
  error: string
  /** True when the database itself is unreachable, so the UI can offer a retry. */
  unreachable?: boolean
}
