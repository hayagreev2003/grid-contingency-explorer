'use client'

import { useEffect, useId, useMemo, useRef, useState } from 'react'

export interface CityOption {
  id: string
  name: string
  peak_demand_mw: number
}

/**
 * Type-ahead over the load centres, in place of a native <select>.
 *
 * Sixty cities in a dropdown is a scroll, not a choice: picking Vijayawada meant
 * dragging past nineteen larger ones, and the list is ordered by demand rather
 * than alphabetically because that ordering is what the panel is about. A filter
 * costs one input and makes the order irrelevant to finding anything.
 *
 * The listbox is left open on selection duty only -- there is no free text to
 * commit. Whatever is typed either matches a city or matches nothing, so the
 * input reverts to the current selection whenever it closes.
 */
export function CitySearch({
  options, value, onChange, disabled,
}: {
  options: CityOption[]
  value: string | null
  onChange: (id: string) => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)

  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const id = useId()

  const selected = options.find(o => o.id === value) ?? null

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return options
    // Rank by where the match lands, not just whether it lands: typing "pu"
    // should offer Pune before Jamshedpur. Ties keep the incoming order, which
    // is by peak demand, so the biggest city of an equally good set leads.
    return options
      .map(o => {
        const at = o.name.toLowerCase().indexOf(q)
        return { o, rank: at < 0 ? -1 : at === 0 ? 0 : /\s/.test(o.name[at - 1]) ? 1 : 2 }
      })
      .filter(r => r.rank >= 0)
      .sort((a, b) => a.rank - b.rank)
      .map(r => r.o)
  }, [options, query])

  // A new filter invalidates the old highlight; the first match is the one Enter
  // should take.
  useEffect(() => { setActive(0) }, [query])

  // Keep the highlighted row visible when it moves by keyboard.
  useEffect(() => {
    if (!open) return
    listRef.current?.children[active]?.scrollIntoView({ block: 'nearest' })
  }, [active, open])

  // Pointer-down rather than click: a press that starts outside has already
  // decided to leave, and waiting for the release leaves the list over whatever
  // is being pressed.
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) close()
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [open])

  const close = () => { setOpen(false); setQuery('') }

  const choose = (o: CityOption) => {
    onChange(o.id)
    close()
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      if (!open) { setOpen(true); return }
      const step = e.key === 'ArrowDown' ? 1 : -1
      setActive(i => Math.min(matches.length - 1, Math.max(0, i + step)))
      return
    }
    if (e.key === 'Enter' && open) {
      const pick = matches[active]
      if (pick) { e.preventDefault(); choose(pick) }
      return
    }
    if (e.key === 'Escape' && open) {
      // The sheet also closes on Escape. Shutting the list is the nearer of the
      // two intentions, so it consumes the key.
      e.preventDefault()
      e.stopPropagation()
      close()
      return
    }
    if (e.key === 'Tab' && open) close()
  }

  return (
    <div className="combo" ref={rootRef}>
      <input
        type="text"
        role="combobox"
        className="combo-input"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-autocomplete="list"
        aria-label="Search load centres"
        aria-activedescendant={
          open && matches[active] ? `${id}-opt-${matches[active].id}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        disabled={disabled}
        placeholder={selected ? 'Search cities' : 'Loading cities'}
        value={open ? query : selected ? `${selected.name} — ${selected.peak_demand_mw.toLocaleString('en-IN')} MW` : ''}
        onChange={e => { setQuery(e.target.value); setOpen(true) }}
        onFocus={() => setOpen(true)}
        onKeyDown={onKeyDown}
      />
      <span className="combo-caret" aria-hidden="true">▾</span>

      {open && (
        <ul className="combo-list" id={`${id}-list`} role="listbox" ref={listRef}>
          {matches.length === 0 ? (
            <li className="combo-empty">No city matches “{query.trim()}”.</li>
          ) : (
            matches.map((o, i) => (
              <li
                key={o.id}
                id={`${id}-opt-${o.id}`}
                role="option"
                aria-selected={o.id === value}
                className={
                  'combo-opt' + (i === active ? ' active' : '') + (o.id === value ? ' current' : '')
                }
                // Keep focus on the input, so the blur that would close the list
                // never happens between press and release.
                onPointerDown={e => e.preventDefault()}
                onClick={() => choose(o)}
                onPointerEnter={() => setActive(i)}
              >
                <span>{o.name}</span>
                <span className="mono small muted">
                  {o.peak_demand_mw.toLocaleString('en-IN')} MW
                </span>
              </li>
            ))
          )}
        </ul>
      )}
    </div>
  )
}
