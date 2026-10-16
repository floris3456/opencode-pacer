// Reads from a CLIProxyAPI (CPA) and the Pacer plugin inside it. The API key is
// only ever sent to the origin of the base URL it was entered with.

import { parseDiscovery, parsePrices, parseUsage, type Discovery, type Price, type UsageView } from "./protocol.js"

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>

export interface Connection {
  /** The CPA OpenAI-compatible base URL, ending in /v1. */
  baseURL: string
  key: string
}

/** Normalises what a user typed: http(s), no credentials or query, ending in /v1. */
export function normaliseBaseURL(raw: string): string | undefined {
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    return undefined
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined
  if (url.username || url.password || url.search || url.hash) return undefined
  let path = url.pathname.replace(/\/+$/, "")
  if (!path.endsWith("/v1")) path += "/v1"
  return url.origin + path
}

export function originOf(baseURL: string): string {
  return new URL(baseURL).origin
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

async function getJSON(fetchFn: Fetch, url: string, key: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const headers: Record<string, string> = { Accept: "application/json" }
    if (key) headers.Authorization = `Bearer ${key}`
    const res = await fetchFn(url, { headers, signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, redirect: "error" })
    if (!res.ok) throw new HttpError(res.status, `${new URL(url).pathname} answered HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

const EVENTS = "/v0/resource/plugins/pacer/events"

/** Whether this CPA runs a Pacer that speaks the client protocol. Sends no key.
 * Undefined is no answer: no reply, a timeout or a server error says nothing about
 * Pacer, so callers keep what they knew. */
export async function discover(fetchFn: Fetch, baseURL: string, timeoutMs = 5000): Promise<Discovery | undefined> {
  const res = await fetchFn(originOf(baseURL) + EVENTS, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(timeoutMs),
    redirect: "manual",
  }).catch(() => undefined)
  if (!res || res.status >= 500 || res.status === 408 || res.status === 429) return undefined
  // A 404 (no Pacer), or a proxy guarding the path with a login redirect or refusal, is an answer.
  if (!res.ok) return { pacer: false, views: [] }
  const text = await res.text().catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return parseDiscovery(JSON.parse(text))
  } catch {
    return parseDiscovery(undefined)
  }
}

/** Every account with a quota meter. Served from Pacer's copy: no provider is asked. */
export async function usage(fetchFn: Fetch, conn: Connection, timeoutMs = 5000, watch?: { cursor?: string; waitMs: number; signal: AbortSignal }): Promise<UsageView> {
  const url = new URL(`${originOf(conn.baseURL)}${EVENTS}?view=usage&auth=api-key&all=true&v=1`)
  if (watch) {
    url.searchParams.set("wait_ms", String(watch.waitMs))
    if (watch.cursor) url.searchParams.set("cursor", watch.cursor)
  }
  const view = parseUsage(await getJSON(fetchFn, url.href, conn.key, timeoutMs, watch?.signal))
  if (!view) throw new Error("Pacer's usage view was not understood")
  return view
}

/** One cancellable shared-credential subscription per OpenCode plugin instance.
 * Pacer wakes the held GET when ANY caller contributes a quota observation.
 * Older servers without cursors fall back to reads of their stored view only.
 */
export async function watchUsage(fetchFn: Fetch, conn: Connection, onView: (view: UsageView) => void, signal: AbortSignal): Promise<void> {
  let cursor: string | undefined
  let retry = 1000
  while (!signal.aborted) {
    let delay: number
    try {
      const view = await usage(fetchFn, conn, 30_000, { cursor, waitMs: 20_000, signal })
      if (signal.aborted) return
      onView(view)
      cursor = view.cursor
      retry = 1000
      // Coalesce bursts without making inference wait for slow viewers.
      delay = cursor ? 50 : 5000
    } catch {
      if (signal.aborted) return
      delay = retry
      retry = Math.min(retry * 2, 30_000)
    }
    await new Promise<void>((resolve) => {
      const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve() }
      const timer = setTimeout(finish, delay)
      signal.addEventListener("abort", finish, { once: true })
      if (signal.aborted) finish()
    })
  }
}

/** A chat capability authorizes its own preview; the CPA API key cannot select another chat. */
export async function chatUsage(fetchFn: Fetch, baseURL: string, capability: string, route: string, timeoutMs = 5000): Promise<UsageView> {
  const url = new URL(originOf(baseURL) + EVENTS)
  url.search = new URLSearchParams({ view: "usage", v: "1", model: route }).toString()
  const view = parseUsage(await getJSON(fetchFn, url.href, capability, timeoutMs))
  if (!view) throw new Error("Pacer's chat usage view was not understood")
  return view
}

/** Pacer's price for each model this key can use (USD per million tokens). */
export async function prices(fetchFn: Fetch, conn: Connection, timeoutMs = 10000): Promise<Record<string, Price>> {
  const url = `${originOf(conn.baseURL)}${EVENTS}?view=prices&auth=api-key`
  const out = parsePrices(await getJSON(fetchFn, url, conn.key, timeoutMs))
  if (!out) throw new Error("Pacer's prices were not understood")
  return out
}

/** CPA's model catalogue: `GET /v1/models?details=true`, else the plain list. */
export async function models(fetchFn: Fetch, conn: Connection, timeoutMs = 10000): Promise<{ details: boolean; data: unknown[] }> {
  const body = (await getJSON(fetchFn, `${conn.baseURL}/models?details=true`, conn.key, timeoutMs)) as Record<string, unknown>
  if (!body || !Array.isArray(body.data)) throw new Error("CPA's model list was not understood")
  return { details: body.schema === "cliproxyapi.model-details/1", data: body.data }
}
