/**
 * Client for the FastAPI backend.
 *
 * The frontend is deployed to Vercel and the API to Render, so requests are
 * cross-origin and NEXT_PUBLIC_API_BASE must point at the Render service. This
 * is a static export, so that value is baked in at build time: changing the
 * backend URL requires a rebuild, not just an environment change.
 *
 * Falling back to an empty string keeps same-origin working, which is what
 * happens when FastAPI serves the built frontend itself (the single-process
 * setup described in the README).
 */
export const API_BASE = (process.env.NEXT_PUBLIC_API_BASE ?? '').replace(/\/$/, '')

export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly unreachable: boolean) {
    super(message)
    this.name = 'ApiError'
  }
}

/** Thrown when a request was superseded by a newer one and cancelled. */
export class AbortedError extends Error {
  constructor() {
    super('Request superseded.')
    this.name = 'AbortedError'
  }
}

/**
 * Every call takes a signal so the caller can cancel a request it no longer
 * wants the answer to. This is load-bearing rather than tidy: each query holds
 * one of ten pooled connections for seconds against the free-tier instance, so
 * a few rapid clicks used to leave a queue of traversals computing outage sets
 * the UI had already moved past, until the pool ran dry and the requests that
 * mattered failed behind them.
 */
export async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`, { signal })
  } catch (err) {
    if (signal?.aborted || (err instanceof DOMException && err.name === 'AbortError')) {
      throw new AbortedError()
    }
    // The backend itself is down or unreachable from the browser.
    throw new ApiError('Cannot reach the application backend.', 0, true)
  }

  const body = await res.json().catch(() => ({ error: 'Malformed response from the server.' }))
  if (!res.ok) {
    // `unreachable` is the server's own word for "there is nothing to talk to",
    // and only that warrants replacing the UI with a retry screen. A 503 from a
    // busy or timed-out query is transient and reported in place instead.
    throw new ApiError(
      body.error ?? `Request failed (${res.status})`,
      res.status,
      Boolean(body.unreachable),
    )
  }
  return body as T
}

/** Build a query string, omitting empties so URLs stay readable. */
export function qs(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const out = search.toString()
  return out ? `?${out}` : ''
}
