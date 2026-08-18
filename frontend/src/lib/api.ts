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

export async function getJson<T>(path: string): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${API_BASE}${path}`)
  } catch {
    // The backend itself is down or unreachable from the browser.
    throw new ApiError('Cannot reach the application backend.', 0, true)
  }

  const body = await res.json().catch(() => ({ error: 'Malformed response from the server.' }))
  if (!res.ok) {
    throw new ApiError(
      body.error ?? `Request failed (${res.status})`,
      res.status,
      Boolean(body.unreachable) || res.status === 503,
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
