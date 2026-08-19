'use client'

import { useMemo } from 'react'

export interface MapSubstation {
  id: string; name: string; voltage_kv: number; lat: number; lon: number
  state: string; region: string
}
export interface MapLine {
  line_id: string; name: string
  from_lat: number; from_lon: number; to_lat: number; to_lon: number
  capacity_mw: number; voltage_kv: number; length_km: number; hvdc: boolean
}
export interface MapLoadCentre {
  id: string; name: string; peak_demand_mw: number; lat: number; lon: number
}

interface Props {
  substations: MapSubstation[]
  lines: MapLine[]
  loadCentres: MapLoadCentre[]
  tripped: Set<string>
  blackedOut: Set<string>
  selectedLoad: string | null
  onToggleLine: (lineId: string) => void
  onSelectLoad: (loadId: string) => void
}

const W = 1000
const H = 1100
const PAD = 40

const HVDC = '#b98cff'
const EHV = '#4da3ff'
const AC400 = '#3a4a60'

/**
 * The map encodes five variables at once -- line colour, line thickness, dot
 * size, dot colour and the dashed stroke -- and none of them is self-evident to
 * someone who has not read the README. The legend is the difference between a
 * picture and a chart.
 */
function Legend() {
  return (
    <div className="legend" aria-hidden="true">
      <div className="legend-row"><span className="swatch" style={{ background: EHV }} />765 kV corridor</div>
      <div className="legend-row"><span className="swatch" style={{ background: HVDC }} />HVDC bipole</div>
      <div className="legend-row"><span className="swatch" style={{ background: AC400 }} />400 kV corridor</div>
      <div className="legend-row">
        <span className="swatch dashed" />out of service
      </div>
      <div className="legend-sep" />
      <div className="legend-row"><span className="dot-swatch" style={{ background: '#546682', width: 5, height: 5 }} />substation</div>
      <div className="legend-row"><span className="dot-swatch" style={{ background: 'rgba(230,237,245,0.75)' }} />city · area ∝ peak demand</div>
      <div className="legend-row"><span className="dot-swatch" style={{ background: 'var(--danger)' }} />city short of peak demand</div>
      <div className="legend-sep" />
      <div className="legend-hint">Line width ∝ capacity. Click a corridor to trip it, a city for its detail.</div>
    </div>
  )
}

/**
 * Plain SVG rather than a tile map: no API key, no external network request at
 * runtime, and the geometry is the point here — the graph, not the basemap.
 * Equirectangular projection is fine over a single country at this scale.
 */
export default function GridMap({
  substations, lines, loadCentres, tripped, blackedOut,
  selectedLoad, onToggleLine, onSelectLoad,
}: Props) {
  const project = useMemo(() => {
    const lats = substations.map(s => s.lat)
    const lons = substations.map(s => s.lon)
    if (!lats.length) return () => ({ x: 0, y: 0 })
    const minLat = Math.min(...lats), maxLat = Math.max(...lats)
    const minLon = Math.min(...lons), maxLon = Math.max(...lons)
    const sx = (W - 2 * PAD) / (maxLon - minLon || 1)
    const sy = (H - 2 * PAD) / (maxLat - minLat || 1)
    const s = Math.min(sx, sy)
    const ox = PAD + ((W - 2 * PAD) - (maxLon - minLon) * s) / 2
    const oy = PAD + ((H - 2 * PAD) - (maxLat - minLat) * s) / 2
    return (lat: number, lon: number) => ({
      x: ox + (lon - minLon) * s,
      y: H - oy - (lat - minLat) * s,
    })
  }, [substations])

  const strokeFor = (l: MapLine) => {
    if (tripped.has(l.line_id)) return 'var(--danger)'
    if (l.hvdc) return HVDC
    if (l.voltage_kv >= 765) return EHV
    return AC400
  }

  return (
    <>
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: '100%', display: 'block' }}
      role="img"
      aria-label="Indian bulk transmission network. Click a line to trip it."
    >
      <rect width={W} height={H} fill="var(--bg)" />

      {/* Corridors — click target is a fat invisible stroke over a thin visible one. */}
      <g>
        {lines.map(l => {
          const a = project(l.from_lat, l.from_lon)
          const b = project(l.to_lat, l.to_lon)
          const out = tripped.has(l.line_id)
          return (
            <g key={l.line_id}>
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke={strokeFor(l)}
                strokeWidth={Math.max(1, Math.min(4, l.capacity_mw / 900))}
                strokeDasharray={out ? '6 5' : undefined}
                opacity={out ? 0.95 : 0.55}
              />
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="transparent" strokeWidth={11}
                style={{ cursor: 'pointer' }}
                onClick={() => onToggleLine(l.line_id)}
              >
                <title>
                  {l.name} · {l.capacity_mw} MW · {l.length_km} km
                  {out ? ' · TRIPPED' : ''} — click to {out ? 'restore' : 'trip'}
                </title>
              </line>
            </g>
          )
        })}
      </g>

      {/* Substations */}
      <g>
        {substations.map(s => {
          const p = project(s.lat, s.lon)
          return (
            <circle
              key={s.id} cx={p.x} cy={p.y}
              r={s.voltage_kv >= 765 ? 3.4 : 2.2}
              fill={s.voltage_kv >= 765 ? EHV : '#546682'}
            >
              <title>{s.name} · {s.voltage_kv} kV · {s.state}</title>
            </circle>
          )
        })}
      </g>

      {/* Load centres — sized by peak demand, red when they lose supply. */}
      <g>
        {loadCentres.map(l => {
          const p = project(l.lat, l.lon)
          const dark = blackedOut.has(l.id)
          const selected = selectedLoad === l.id
          return (
            <g key={l.id} style={{ cursor: 'pointer' }} onClick={() => onSelectLoad(l.id)}>
              <circle
                cx={p.x} cy={p.y}
                r={4 + Math.sqrt(l.peak_demand_mw) / 12}
                fill={dark ? 'var(--danger)' : 'rgba(230,237,245,0.75)'}
                stroke={selected ? 'var(--accent)' : dark ? 'var(--danger)' : 'transparent'}
                strokeWidth={selected ? 2.5 : 1}
                opacity={dark ? 0.95 : 0.8}
              />
              {(selected || dark || l.peak_demand_mw >= 2200) && (
                <text
                  x={p.x + 9} y={p.y + 4}
                  fill={dark ? 'var(--danger)' : 'var(--muted)'}
                  fontSize={12}
                >
                  {l.name}
                </text>
              )}
              <title>{l.name} · {l.peak_demand_mw} MW peak{dark ? ' · NO SUPPLY' : ''}</title>
            </g>
          )
        })}
      </g>
    </svg>
    <Legend />
    </>
  )
}
