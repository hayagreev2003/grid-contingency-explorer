'use client'

import type { AdequacyRow, CriticalLine, FuelMixRow, IslandedRow, SupplyPath } from '@/lib/types'

const FUEL_COLOR: Record<string, string> = {
  coal: 'var(--coal)', lignite: 'var(--lignite)', gas: 'var(--gas)',
  nuclear: 'var(--nuclear)', hydro: 'var(--hydro)', solar: 'var(--solar)',
  wind: 'var(--wind)',
}

export function Skeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="stack" aria-busy="true" aria-live="polite">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="skeleton" style={{ height: 16, width: `${95 - i * 9}%` }} />
      ))}
    </div>
  )
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="banner">
      <div style={{ flex: 1 }}>
        <strong>Database unreachable</strong>
        <div className="small muted">{message}</div>
      </div>
      <button onClick={onRetry}>Retry</button>
    </div>
  )
}

export function AdequacyPanel({
  atRisk, islanded, shortfallMw, population, trippedCount, loading,
}: {
  atRisk: AdequacyRow[]; islanded: IslandedRow[]; shortfallMw: number
  population: number; trippedCount: number; loading: boolean
}) {
  if (loading) return <Skeleton rows={5} />

  if (trippedCount === 0 && atRisk.length === 0) {
    return (
      <div className="empty">
        <div style={{ fontSize: 26, marginBottom: 6 }}>⚡</div>
        Every city can be supplied to its peak demand.<br />
        <span className="small">Click a corridor on the map to take it out of service.</span>
      </div>
    )
  }

  if (atRisk.length === 0) {
    return (
      <div className="card">
        <div className="stat ok">
          <span className="value">N–{trippedCount} secure</span>
        </div>
        <p className="small muted" style={{ margin: '6px 0 0' }}>
          The network re-routes around this outage: every city still has enough
          deliverable capacity within {3} hops to cover its peak demand.
        </p>
      </div>
    )
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="stat danger">
          <span className="value">{Math.round(shortfallMw).toLocaleString('en-IN')}</span>
          <span className="unit">MW of unmet peak demand</span>
        </div>
        <div className="small muted" style={{ marginTop: 4 }}>
          {atRisk.length} cities short · {(population / 1e6).toFixed(1)} M people
          {islanded.length > 0 && (
            <> · <span style={{ color: 'var(--danger)' }}>{islanded.length} fully islanded</span></>
          )}
        </div>
      </div>
      <ul className="list">
        {atRisk.map(row => {
          const covered = row.demand_mw > 0
            ? Math.min(100, (100 * row.deliverable_mw) / row.demand_mw)
            : 0
          return (
            <li key={row.id} style={{ display: 'block' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                <span>
                  {row.load_centre}
                  <span className="small muted"> · {row.state}</span>
                </span>
                <span className="mono small" style={{ color: 'var(--danger)' }}>
                  −{Math.round(row.shortfall_mw).toLocaleString('en-IN')} MW
                </span>
              </div>
              <div className="bar" style={{ marginTop: 5 }}>
                <span style={{ width: `${covered}%`, background: 'var(--warn)' }} />
              </div>
              <div className="small muted" style={{ marginTop: 3 }}>
                {Math.round(row.deliverable_mw).toLocaleString('en-IN')} MW deliverable of{' '}
                {row.demand_mw.toLocaleString('en-IN')} MW peak
              </div>
            </li>
          )
        })}
      </ul>
      <p className="small muted">
        Deliverable capacity is an upper bound: shared corridors are counted once
        per plant. It ranks and compares correctly, but it is not a load flow.
      </p>
    </div>
  )
}

export function SupplyPathPanel({ paths, loading }: { paths: SupplyPath[]; loading: boolean }) {
  if (loading) return <Skeleton rows={4} />
  if (!paths.length) {
    return <div className="empty">No surviving supply path within the hop limit.</div>
  }
  return (
    <ul className="list">
      {paths.slice(0, 12).map(p => (
        <li key={p.plant} style={{ display: 'block' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span>
              <span
                className="chip"
                style={{ borderColor: FUEL_COLOR[p.fuel], marginRight: 6 }}
              >
                <span className="dot" style={{ background: FUEL_COLOR[p.fuel] }} />
                {p.fuel}
              </span>
              {p.plant}
            </span>
            <span className="mono small">{p.hop_count === 0 ? 'on-bus' : `${p.hop_count} hop${p.hop_count === 1 ? '' : 's'}`}</span>
          </div>
          <div className="small muted" style={{ marginTop: 3 }}>
            {p.plant_mw.toLocaleString('en-IN')} MW installed · corridor limit{' '}
            <span style={{ color: p.constrained ? 'var(--warn)' : 'var(--ok)' }}>
              {p.bottleneck_mw ? `${p.bottleneck_mw.toLocaleString('en-IN')} MW` : 'on-bus'}
            </span>
            {p.constrained && ` — delivers ${p.deliverable_mw.toLocaleString('en-IN')} MW`}
          </div>
          <div className="small muted mono" style={{ marginTop: 3, opacity: 0.75 }}>
            {p.hops.join(' → ')}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function FuelMixPanel({
  mix, renewablePct, loading,
}: { mix: FuelMixRow[]; renewablePct: number; loading: boolean }) {
  if (loading) return <Skeleton rows={3} />
  if (!mix.length) return <div className="empty">No reachable generation.</div>
  return (
    <div className="stack">
      <div className="stat">
        <span className="value">{renewablePct}%</span>
        <span className="unit">of reachable capacity is solar, wind or hydro</span>
      </div>
      <div className="bar" style={{ display: 'flex', height: 10 }}>
        {mix.map(row => (
          <span
            key={row.fuel}
            style={{ width: `${row.pct}%`, background: FUEL_COLOR[row.fuel] }}
            title={`${row.fuel}: ${row.pct}%`}
          />
        ))}
      </div>
      <ul className="list">
        {mix.map(row => (
          <li key={row.fuel}>
            <span className="chip" style={{ borderColor: FUEL_COLOR[row.fuel] }}>
              <span className="dot" style={{ background: FUEL_COLOR[row.fuel] }} />
              {row.fuel}
            </span>
            <span className="mono small">
              {row.reachable_mw.toLocaleString('en-IN')} MW · {row.pct}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

export function CriticalLinesPanel({
  lines, tripped, onToggle, loading,
}: {
  lines: CriticalLine[]; tripped: Set<string>
  onToggle: (id: string) => void; loading: boolean
}) {
  if (loading) return <Skeleton rows={5} />
  return (
    <ul className="list">
      {lines.map(l => (
        <li key={l.line_id}>
          <button
            className="ghost"
            style={{
              textAlign: 'left', padding: 0, border: 0, flex: 1,
              color: tripped.has(l.line_id) ? 'var(--danger)' : 'inherit',
            }}
            onClick={() => onToggle(l.line_id)}
            title="Trip this line"
          >
            {l.line}
          </button>
          <span
            className="mono small muted"
            title={
              `${(l.mw_carried / 1000).toFixed(0)} GW of generation across ` +
              `${l.paths_carried} plant-to-city routes. A ranking score, not a ` +
              `power flow: a plant is counted once per route it uses.`
            }
          >
            {(l.mw_carried / 1000).toFixed(0)} GW routed
          </span>
        </li>
      ))}
    </ul>
  )
}
