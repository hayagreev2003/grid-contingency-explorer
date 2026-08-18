'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import GridMap, { MapLine, MapLoadCentre, MapSubstation } from '@/components/GridMap'
import {
  AdequacyPanel, CriticalLinesPanel, ErrorBanner, FuelMixPanel, Skeleton, SupplyPathPanel,
} from '@/components/Panels'
import { getJson, qs } from '@/lib/api'
import type {
  AdequacyRow, CriticalLine, FuelMixRow, IslandedRow, SupplyPath,
} from '@/lib/types'

interface Topology {
  substations: MapSubstation[]
  lines: MapLine[]
  loadCentres: MapLoadCentre[]
}

export default function Home() {
  const [topology, setTopology] = useState<Topology | null>(null)
  const [critical, setCritical] = useState<CriticalLine[]>([])
  const [fatal, setFatal] = useState<string | null>(null)

  const [tripped, setTripped] = useState<string[]>([])
  const [selectedLoad, setSelectedLoad] = useState<string | null>(null)
  const [maxHops, setMaxHops] = useState(4)

  const [contingency, setContingency] = useState<{
    cities: AdequacyRow[]
    at_risk: AdequacyRow[]
    islanded: IslandedRow[]
    shortfall_mw: number
    population_at_risk: number
  } | null>(null)
  const [paths, setPaths] = useState<SupplyPath[]>([])
  const [mix, setMix] = useState<{ mix: FuelMixRow[]; renewable_pct: number } | null>(null)

  const [loadingBase, setLoadingBase] = useState(true)
  // Render's free plan sleeps a service after ~15 minutes of inactivity, and the
  // first request afterwards waits on a cold start. Rather than show a skeleton
  // for a minute with no explanation, say what is happening.
  const [waking, setWaking] = useState(false)
  const [loadingCont, setLoadingCont] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)

  const trippedParam = tripped.join(',')

  const loadBase = useCallback(async () => {
    setLoadingBase(true)
    setFatal(null)
    const wakeTimer = setTimeout(() => setWaking(true), 5000)
    try {
      const [topo, crit] = await Promise.all([
        getJson<Topology>('/api/topology'),
        getJson<{ lines: CriticalLine[] }>('/api/critical?limit=12'),
      ])
      setTopology(topo)
      setCritical(crit.lines)
      setSelectedLoad(prev => prev ?? topo.loadCentres[0]?.id ?? null)
    } catch (err) {
      setFatal(err instanceof Error ? err.message : 'Unknown error')
    } finally {
      clearTimeout(wakeTimer)
      setWaking(false)
      setLoadingBase(false)
    }
  }, [])

  useEffect(() => { void loadBase() }, [loadBase])

  // Q3 re-runs on every change to the outage set — that is the whole interaction.
  useEffect(() => {
    if (fatal) return
    let cancelled = false
    setLoadingCont(true)
    getJson<typeof contingency>(`/api/contingency${qs({ tripped: trippedParam })}`)
      .then(data => { if (!cancelled) setContingency(data) })
      .catch(err => { if (!cancelled) setFatal(err.message) })
      .finally(() => { if (!cancelled) setLoadingCont(false) })
    return () => { cancelled = true }
  }, [trippedParam, fatal])

  // Q1/Q2 and Q5 for the selected city.
  useEffect(() => {
    if (!selectedLoad || fatal) return
    let cancelled = false
    setLoadingDetail(true)
    const params = qs({ loadId: selectedLoad, tripped: trippedParam, maxHops })
    Promise.all([
      getJson<{ paths: SupplyPath[] }>(`/api/path${params}`),
      getJson<{ mix: FuelMixRow[]; renewable_pct: number }>(`/api/mix${params}`),
    ])
      .then(([p, m]) => { if (!cancelled) { setPaths(p.paths); setMix(m) } })
      .catch(err => { if (!cancelled) setFatal(err.message) })
      .finally(() => { if (!cancelled) setLoadingDetail(false) })
    return () => { cancelled = true }
  }, [selectedLoad, trippedParam, maxHops, fatal])

  const toggleLine = useCallback((lineId: string) => {
    setTripped(prev =>
      prev.includes(lineId) ? prev.filter(id => id !== lineId) : [...prev, lineId],
    )
  }, [])

  const trippedSet = useMemo(() => new Set(tripped), [tripped])
  const atRiskIds = useMemo(
    () => new Set((contingency?.at_risk ?? []).map(r => r.id)),
    [contingency],
  )
  const lineNames = useMemo(
    () => new Map((topology?.lines ?? []).map(l => [l.line_id, l.name])),
    [topology],
  )
  const selectedName = useMemo(
    () => topology?.loadCentres.find(l => l.id === selectedLoad)?.name ?? '',
    [topology, selectedLoad],
  )

  if (fatal) {
    return (
      <main style={{ maxWidth: 620, margin: '18vh auto', padding: 20 }}>
        <h1 style={{ marginBottom: 14 }}>Grid Contingency Explorer</h1>
        <ErrorBanner message={fatal} onRetry={() => void loadBase()} />
        <p className="small muted" style={{ marginTop: 14 }}>
          The application needs a running CognoDB instance. Check <code>COGNODB_URI</code> and{' '}
          <code>COGNODB_PASSWORD</code>, then retry.
        </p>
      </main>
    )
  }

  return (
    <div className="app">
      <header>
        <h1>Grid Contingency Explorer</h1>
        <span className="sub">Indian bulk transmission network · CognoDB</span>
        <span className="spacer" />
        {tripped.length > 0 && (
          <>
            <span className="small muted">{tripped.length} line(s) out</span>
            <button onClick={() => setTripped([])}>Restore all</button>
          </>
        )}
      </header>

      <aside className="panel left stack">
        <h2>Outage set</h2>
        {tripped.length === 0 ? (
          <p className="small muted">
            Click any corridor on the map to take it out of service. Everything on
            the right recomputes against the surviving network.
          </p>
        ) : (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {tripped.map(id => (
              <span key={id} className="chip">
                <span className="dot" style={{ background: 'var(--danger)' }} />
                {lineNames.get(id) ?? id}
                <button onClick={() => toggleLine(id)} aria-label="Restore line">×</button>
              </span>
            ))}
          </div>
        )}

        <h2>Most critical corridors</h2>
        <p className="small muted" style={{ marginTop: -6 }}>
          Ranked by the generation capacity whose shortest route to a city runs
          through them. Click to trip.
        </p>
        <CriticalLinesPanel
          lines={critical} tripped={trippedSet}
          onToggle={toggleLine} loading={loadingBase}
        />
      </aside>

      <div className="map">
        {loadingBase ? (
          <div style={{ padding: 24 }}>
            {waking && (
              <p className="small muted" style={{ marginBottom: 14 }}>
                Waking the backend — the free hosting tier sleeps after a period
                of inactivity, so the first load can take up to a minute. Later
                requests are fast.
              </p>
            )}
            <Skeleton rows={8} />
          </div>
        ) : (
          <GridMap
            substations={topology!.substations}
            lines={topology!.lines}
            loadCentres={topology!.loadCentres}
            tripped={trippedSet}
            blackedOut={atRiskIds}
            selectedLoad={selectedLoad}
            onToggleLine={toggleLine}
            onSelectLoad={setSelectedLoad}
          />
        )}
      </div>

      <aside className="panel right stack">
        <h2>Supply adequacy</h2>
        <AdequacyPanel
          atRisk={contingency?.at_risk ?? []}
          islanded={contingency?.islanded ?? []}
          shortfallMw={contingency?.shortfall_mw ?? 0}
          population={contingency?.population_at_risk ?? 0}
          trippedCount={tripped.length}
          loading={loadingCont}
        />

        <h2>City detail</h2>
        <select
          value={selectedLoad ?? ''}
          onChange={e => setSelectedLoad(e.target.value)}
          disabled={loadingBase}
          aria-label="Select a load centre"
        >
          {(topology?.loadCentres ?? []).map(l => (
            <option key={l.id} value={l.id}>
              {l.name} — {l.peak_demand_mw.toLocaleString('en-IN')} MW
            </option>
          ))}
        </select>

        <label className="small muted" style={{ display: 'block' }}>
          Reachable within {maxHops} hops
          <input
            type="range" min={1} max={5} value={maxHops}
            onChange={e => setMaxHops(Number(e.target.value))}
            style={{ width: '100%' }}
          />
        </label>

        <h3>Deliverable generation mix{selectedName && ` · ${selectedName}`}</h3>
        <FuelMixPanel
          mix={mix?.mix ?? []}
          renewablePct={mix?.renewable_pct ?? 0}
          loading={loadingDetail}
        />

        <h3>Supply paths</h3>
        <SupplyPathPanel paths={paths} loading={loadingDetail} />
      </aside>
    </div>
  )
}
