'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

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

// The viewBox is a fixed 1000 units wide and as tall as the container's aspect
// ratio makes it. A constant 1000x1100 box was letterboxed inside every shape
// that was not 10:11 -- worst on a phone, where the country ended up a square in
// the middle of a tall screen with dead bands above and below it.
const W = 1000
const H0 = 1100
const MIN_H = 620
const MAX_H = 2400
const PAD = 40

const HVDC = '#b98cff'
const EHV = '#4da3ff'
const AC400 = '#3a4a60'

// Zoom bounds. 1x is the whole country; 14x is enough to separate the corridors
// around Delhi, which is where the network is densest and the lines shortest.
const MIN_K = 1
const MAX_K = 14
const STEP = 1.6
//: A pointer that moves further than this between down and up was a pan, not a
//  click, and must not trip the corridor it happens to be released over.
const DRAG_SLOP = 4

interface View { k: number; x: number; y: number }
const HOME: View = { k: 1, x: 0, y: 0 }

/**
 * Keep the scaled content covering the viewBox, so panning can never leave the
 * map half empty. At k = 1 the only legal offset is 0, which makes "reset" and
 * "zoomed all the way out" the same state.
 */
function clampView(v: View, h: number): View {
  const k = Math.min(MAX_K, Math.max(MIN_K, v.k))
  return {
    k,
    x: Math.min(0, Math.max((1 - k) * W, v.x)),
    y: Math.min(0, Math.max((1 - k) * h, v.y)),
  }
}

/**
 * The map encodes five variables at once -- line colour, line thickness, dot
 * size, dot colour and the dashed stroke -- and none of them is self-evident to
 * someone who has not read the README. The legend is the difference between a
 * picture and a chart.
 *
 * On a phone it is also a third of the map, so it collapses to the pill that
 * opens it. Which of the two it is stays a CSS question -- the toggle and the
 * collapsed state only exist inside the compact media query -- so the desktop
 * legend is never at the mercy of a media query read after hydration.
 */
function Legend() {
  // null until the first effect: the markup is prerendered, and a boolean picked
  // on the server would be wrong for one of the two layouts. While it is null
  // the CSS decides -- open where there is room, shut on a phone -- so nothing
  // flashes and nothing has to be un-drawn.
  const [open, setOpen] = useState<boolean | null>(null)

  useEffect(() => {
    setOpen(!window.matchMedia('(max-width: 1100px)').matches)
  }, [])

  return (
    <div className="legend" data-open={open === null ? undefined : open}>
      <button
        className="legend-toggle"
        onClick={() => setOpen(o => o === null ? false : !o)}
        aria-expanded={open ?? true}
        aria-controls="map-legend-body"
      >
        <span className="caret" aria-hidden="true">▶</span>
        Legend
      </button>
      <div className="legend-body" id="map-legend-body" aria-hidden="true">
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
        <div className="legend-hint">
          Line width ∝ capacity. Select a corridor to trip it, a city for its
          detail. Scroll, pinch or use + / − to zoom, drag to pan — the corridors
          around Delhi are short and need it.
        </div>
      </div>
    </div>
  )
}

/**
 * Plain SVG rather than a tile map: no API key, no external network request at
 * runtime, and the geometry is the point here — the graph, not the basemap.
 * Equirectangular projection is fine over a single country at this scale.
 *
 * Zoom and pan are a transform on one group rather than a moving viewBox, so the
 * projection stays a pure function of the data. Strokes are drawn with
 * `vector-effect: non-scaling-stroke` and radii are divided by the zoom factor,
 * which means every hit target keeps its size in screen pixels while the
 * geometry spreads apart: zooming in buys separation, not fatter lines.
 */
export default function GridMap({
  substations, lines, loadCentres, tripped, blackedOut,
  selectedLoad, onToggleLine, onSelectLoad,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null)
  const [view, setView] = useState<View>(HOME)
  // viewBox height, tracking the element's own aspect ratio.
  const [H, setH] = useState(H0)
  const [panning, setPanning] = useState(false)

  // Live pointers, keyed by pointerId: one is a pan, two are a pinch.
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinchDist = useRef(0)
  const dragged = useRef(false)
  //: Where the current gesture started, in client pixels — the slop test's origin.
  const dragStart = useRef<{ x: number; y: number } | null>(null)

  useEffect(() => {
    const svg = svgRef.current
    if (!svg || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect
      if (!width || !height) return
      const next = Math.round(Math.min(MAX_H, Math.max(MIN_H, (W * height) / width)))
      // Ignore sub-8-unit jitter; a scrollbar appearing must not requeue a
      // resize of the thing that made it appear.
      setH(prev => (Math.abs(prev - next) < 8 ? prev : next))
      // A shorter box can leave the current pan outside its own bounds.
      setView(v => clampView(v, next))
    })
    ro.observe(svg)
    return () => ro.disconnect()
  }, [])

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
  }, [substations, H])

  /** Client pixels -> viewBox units, via the element's own CTM so the letterboxing
   *  from preserveAspectRatio is accounted for rather than guessed at. */
  const toLocal = useCallback((clientX: number, clientY: number) => {
    const ctm = svgRef.current?.getScreenCTM()
    if (!ctm) return { x: W / 2, y: H / 2 }
    const inv = ctm.inverse()
    return {
      x: inv.a * clientX + inv.c * clientY + inv.e,
      y: inv.b * clientX + inv.d * clientY + inv.f,
    }
  }, [H])

  /** Scale by `factor`, keeping whatever is under (clientX, clientY) fixed. */
  const zoomBy = useCallback((factor: number, clientX?: number, clientY?: number) => {
    const anchor = clientX === undefined || clientY === undefined
      ? { x: W / 2, y: H / 2 }
      : toLocal(clientX, clientY)
    setView(prev => {
      const k = Math.min(MAX_K, Math.max(MIN_K, prev.k * factor))
      const ratio = k / prev.k
      return clampView({
        k,
        x: anchor.x - (anchor.x - prev.x) * ratio,
        y: anchor.y - (anchor.y - prev.y) * ratio,
      }, H)
    })
  }, [toLocal, H])

  // Wheel is registered by hand because React's wheel listener is passive, and a
  // passive listener cannot preventDefault -- the page would scroll as well.
  useEffect(() => {
    const svg = svgRef.current
    if (!svg) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY
      zoomBy(Math.exp(-dy * 0.0018), e.clientX, e.clientY)
    }
    svg.addEventListener('wheel', onWheel, { passive: false })
    return () => svg.removeEventListener('wheel', onWheel)
  }, [zoomBy])

  // Drag and pinch are tracked on the window rather than through
  // setPointerCapture: capturing on the <svg> would retarget the subsequent
  // click away from the corridor that was pressed, and clicking corridors is the
  // whole interaction.
  useEffect(() => {
    const dist = () => {
      const [a, b] = [...pointers.current.values()]
      return Math.hypot(a.x - b.x, a.y - b.y)
    }

    const onMove = (e: PointerEvent) => {
      const prev = pointers.current.get(e.pointerId)
      if (!prev) return
      pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })

      if (pointers.current.size >= 2) {
        const [a, b] = [...pointers.current.values()]
        const next = dist()
        if (pinchDist.current > 0 && next > 0) {
          zoomBy(next / pinchDist.current, (a.x + b.x) / 2, (a.y + b.y) / 2)
        }
        pinchDist.current = next
        dragged.current = true
        return
      }

      if (Math.hypot(e.clientX - prev.x, e.clientY - prev.y) > 0) {
        // Deltas are converted through the CTM, so a pan tracks the pointer
        // exactly at any zoom level and at any panel width.
        const from = toLocal(prev.x, prev.y)
        const to = toLocal(e.clientX, e.clientY)
        setView(v => clampView({ ...v, x: v.x + (to.x - from.x), y: v.y + (to.y - from.y) }, H))
      }
      if (!dragged.current) {
        const start = dragStart.current
        if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > DRAG_SLOP) {
          dragged.current = true
        }
      }
    }

    const onUp = (e: PointerEvent) => {
      pointers.current.delete(e.pointerId)
      if (pointers.current.size < 2) pinchDist.current = 0
      if (pointers.current.size === 0) setPanning(false)
    }

    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
    return () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
    }
  }, [toLocal, zoomBy, H])

  const onPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY })
    dragStart.current = { x: e.clientX, y: e.clientY }
    dragged.current = false
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinchDist.current = Math.hypot(a.x - b.x, a.y - b.y)
    }
    setPanning(true)
  }

  // A release that ended a pan lands on some corridor or city. Swallow it.
  const ifClick = (fn: () => void) => () => { if (!dragged.current) fn() }

  const { k } = view
  const atHome = view.k === 1 && view.x === 0 && view.y === 0
  const strokeFor = (l: MapLine) => {
    if (tripped.has(l.line_id)) return 'var(--danger)'
    if (l.hvdc) return HVDC
    if (l.voltage_kv >= 765) return EHV
    return AC400
  }

  return (
    <>
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{
        width: '100%', height: '100%', display: 'block',
        cursor: panning ? 'grabbing' : 'grab',
        touchAction: 'none',
      }}
      role="img"
      aria-label="Indian bulk transmission network. Scroll to zoom, drag to pan, click a line to trip it."
      onPointerDown={onPointerDown}
    >
      <rect
        width={W} height={H} fill="var(--bg)"
        onDoubleClick={e => zoomBy(STEP, e.clientX, e.clientY)}
      />

      <g transform={`translate(${view.x} ${view.y}) scale(${k})`}>
      {/* Corridors — click target is a fat invisible stroke over a thin visible one.
          Both are non-scaling, so the 11px target stays 11px however far in you are. */}
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
                vectorEffect="non-scaling-stroke"
              />
              <line
                x1={a.x} y1={a.y} x2={b.x} y2={b.y}
                stroke="transparent" strokeWidth={11}
                vectorEffect="non-scaling-stroke"
                style={{ cursor: 'pointer' }}
                onClick={ifClick(() => onToggleLine(l.line_id))}
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
              r={(s.voltage_kv >= 765 ? 3.4 : 2.2) / k}
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
          // Zooming in is also how you ask for more labels: the threshold falls
          // as the map spreads out and there is room to print them.
          const labelled = selected || dark || l.peak_demand_mw >= 2200 / k
          return (
            <g key={l.id} style={{ cursor: 'pointer' }} onClick={ifClick(() => onSelectLoad(l.id))}>
              <circle
                cx={p.x} cy={p.y}
                r={(4 + Math.sqrt(l.peak_demand_mw) / 12) / k}
                fill={dark ? 'var(--danger)' : 'rgba(230,237,245,0.75)'}
                stroke={selected ? 'var(--accent)' : dark ? 'var(--danger)' : 'transparent'}
                strokeWidth={selected ? 2.5 : 1}
                vectorEffect="non-scaling-stroke"
                opacity={dark ? 0.95 : 0.8}
              />
              {labelled && (
                <text
                  x={p.x + 9 / k} y={p.y + 4 / k}
                  fill={dark ? 'var(--danger)' : 'var(--muted)'}
                  fontSize={12 / k}
                >
                  {l.name}
                </text>
              )}
              <title>{l.name} · {l.peak_demand_mw} MW peak{dark ? ' · NO SUPPLY' : ''}</title>
            </g>
          )
        })}
      </g>
      </g>
    </svg>

    <div className="map-controls">
      <button onClick={() => zoomBy(STEP)} disabled={k >= MAX_K} aria-label="Zoom in" title="Zoom in">+</button>
      <button onClick={() => zoomBy(1 / STEP)} disabled={k <= MIN_K} aria-label="Zoom out" title="Zoom out">−</button>
      <button onClick={() => setView(HOME)} disabled={atHome} aria-label="Reset the view" title="Reset view">⤾</button>
      <span className="zoom-readout" aria-live="polite">{k.toFixed(1)}×</span>
    </div>
    <Legend />
    </>
  )
}
