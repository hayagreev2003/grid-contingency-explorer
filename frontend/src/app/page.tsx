'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import GridMap, { MapLine, MapLoadCentre, MapSubstation } from '@/components/GridMap'
import {
  AdequacyPanel, CriticalLinesPanel, ErrorBanner, FuelMixPanel, NoticeBanner, Skeleton,
  SupplyPathPanel,
} from '@/components/Panels'
import { AbortedError, ApiError, getJson, qs } from '@/lib/api'
import type {
  AdequacyRow, CriticalLine, FuelMixRow, IslandedRow, SupplyPath,
} from '@/lib/types'

// How long a change to the outage set waits before it is asked about, so that a
// run of clicks costs one round of queries instead of one per click. Short
// enough to feel immediate, long enough to swallow a burst.
const BURST_MS = 250

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
  // A transient failure -- the instance busy, or a query it could not finish in
  // time -- leaves the map and the outage set usable and says so in place. Only
  // "there is no database to talk to" replaces the UI (`fatal`).
  //
  // Kept per source rather than as one string: the adequacy sweep and the city
  // detail fail independently, and a success on one must not clear the other's
  // notice while that panel is still showing nothing.
  const [notices, setNotices] = useState<{ cont?: string; detail?: string }>({})
  // Bumped by the notice's Retry button to re-run the queries below unchanged.
  const [attempt, setAttempt] = useState(0)
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

  // One place that decides what an error means: cancelled requests are not
  // failures at all, an unreachable backend is fatal, and everything else is
  // reported next to the panels it affected.
  const report = useCallback((source: 'cont' | 'detail', err: unknown) => {
    if (err instanceof AbortedError) return
    const message = err instanceof Error ? err.message : 'Unknown error'
    if (err instanceof ApiError && !err.unreachable) {
      setNotices(prev => ({ ...prev, [source]: message }))
    } else {
      setFatal(message)
    }
  }, [])

  const clearNotice = useCallback((source: 'cont' | 'detail') => {
    setNotices(prev => (source in prev ? { ...prev, [source]: undefined } : prev))
  }, [])

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
  //
  // Two things keep that from flooding the instance. The request is aborted when
  // the outage set changes again, so a superseded traversal stops occupying a
  // connection instead of computing an answer nobody will read. And the round is
  // held for BURST_MS first, so tripping five corridors in quick succession asks
  // one question rather than five.
  useEffect(() => {
    if (fatal) return
    const controller = new AbortController()
    setLoadingCont(true)
    const timer = setTimeout(() => {
      getJson<typeof contingency>(
        `/api/contingency${qs({ tripped: trippedParam })}`, controller.signal,
      )
        .then(data => { setContingency(data); clearNotice('cont') })
        .catch(err => report('cont', err))
        .finally(() => { if (!controller.signal.aborted) setLoadingCont(false) })
    }, BURST_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [trippedParam, fatal, attempt, report, clearNotice])

  // Q1/Q2 and Q5 for the selected city.
  useEffect(() => {
    if (!selectedLoad || fatal) return
    const controller = new AbortController()
    setLoadingDetail(true)
    const params = qs({ loadId: selectedLoad, tripped: trippedParam, maxHops })
    const timer = setTimeout(() => {
      Promise.all([
        getJson<{ paths: SupplyPath[] }>(`/api/path${params}`, controller.signal),
        getJson<{ mix: FuelMixRow[]; renewable_pct: number }>(`/api/mix${params}`, controller.signal),
      ])
        .then(([p, m]) => { setPaths(p.paths); setMix(m); clearNotice('detail') })
        .catch(err => report('detail', err))
        .finally(() => { if (!controller.signal.aborted) setLoadingDetail(false) })
    }, BURST_MS)
    return () => { clearTimeout(timer); controller.abort() }
  }, [selectedLoad, trippedParam, maxHops, fatal, attempt, report, clearNotice])

  const toggleLine = useCallback((lineId: string) => {
    setTripped(prev =>
      prev.includes(lineId) ? prev.filter(id => id !== lineId) : [...prev, lineId],
    )
  }, [])

  // One banner, whichever failed: two stacked messages for the same underlying
  // "the instance is busy" would say the same thing twice.
  const notice = notices.cont ?? notices.detail ?? null

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
        {notice && (
          <NoticeBanner
            message={notice}
            onRetry={() => { setNotices({}); setAttempt(n => n + 1) }}
          />
        )}
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
