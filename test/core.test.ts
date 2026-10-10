import { describe, expect, test } from "bun:test"
import {
  bar,
  countdown,
  declaration,
  decodeQuota,
  discover,
  durationLabel,
  Meter,
  models,
  normaliseBaseURL,
  parseCatalogue,
  parseDiscovery,
  prices,
  usage,
  windowLine,
  withPrices,
  costOf,
  type Fetch,
  type QuotaReply,
} from "../src/core/index.js"

const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")

// The exact value Pacer's Go test decoded (pacer-core 3ca3fbb, client_test.go).
const pacerSample =
  "eyJ2IjoxLCJwcm92aWRlciI6ImNsYXVkZSIsImF1dGgiOiJhIiwiYWxpYXMiOiJBIiwiYXRfbXMiOjE3OTE1ODcyMzM4NjUsIndpbmRvd3MiOlt7InNjb3BlIjoiYWxsIiwic2Vjb25kcyI6MTgwMDAsImxlZnQiOjYwLCJyZXNldF9tcyI6MTc5MTU5NDQzMzAwMCwicmVzZXRfcXVhbGl0eSI6ImFic29sdXRlIiwic3RhdGUiOiJjdXJyZW50IiwicmVhZF9tcyI6MTc5MTU4NzIzMzg2NSwic291cmNlIjoiaGVhZGVyIiwiYXBwbGllcyI6dHJ1ZX0seyJzY29wZSI6ImFsbCIsInNlY29uZHMiOjYwNDgwMCwibGVmdCI6NzAsInJlc2V0X21zIjoxNzkxODQ2NDMzODY0LCJyZXNldF9xdWFsaXR5IjoiYWJzb2x1dGUiLCJzdGF0ZSI6ImN1cnJlbnQiLCJyZWFkX21zIjoxNzkxNTg3MjMzODY0LCJzb3VyY2UiOiJoZWFkZXIiLCJhcHBsaWVzIjp0cnVlfV19"

describe("protocol", () => {
  test("declaration", () => {
    expect(declaration({ quota: true })).toBe("v=1; caps=quota")
    expect(declaration({ quota: false })).toBeUndefined()
  })

  test("decodes the value Pacer sends", () => {
    const q = decodeQuota(pacerSample)!
    expect(q.provider).toBe("claude")
    expect(q.auth).toBe("a")
    expect(q.alias).toBe("A")
    expect(q.windows.map((w) => [w.seconds, w.left, w.state])).toEqual([
      [18000, 60, "current"],
      [604800, 70, "current"],
    ])
    expect(q.windows[0].reset_ms).toBe(1791594433000)
  })

  test("refuses what it does not understand", () => {
    for (const bad of [
      undefined,
      "",
      "not base64!",
      b64url({ v: 2, provider: "claude", auth: "a", at_ms: 1, windows: [] }),
      b64url({ v: 1, auth: "a", at_ms: 1, windows: [] }),
      b64url([1, 2]),
      Buffer.from("{").toString("base64url"),
    ])
      expect(decodeQuota(bad)).toBeUndefined()
    // Malformed windows are dropped, the rest kept.
    const q = decodeQuota(
      b64url({ v: 1, provider: "codex", auth: "x", at_ms: 5, windows: [{ scope: "all", seconds: 604800, state: "current", left: 140 }, { scope: "all", seconds: 18000, state: "partial" }] }),
    )!
    expect(q.windows.length).toBe(1)
    expect(q.windows[0].seconds).toBe(18000)
  })

  test("discovery needs Pacer's client protocol", () => {
    expect(parseDiscovery({ mode: "shadow", protocol: 1 }).pacer).toBe(false)
    const ok = { protocol: 1, pacer: true, client: { version: 1, request_header: "X-Pacer-Client", caps: ["quota"], quota_header: "X-Pacer-Quota", views: ["usage", "prices"] } }
    expect(parseDiscovery(ok)).toEqual({ pacer: true, views: ["usage", "prices"] })
    expect(parseDiscovery({ ...ok, client: { ...ok.client, version: 2 } }).pacer).toBe(false)
  })
})

describe("cpa", () => {
  test("base URL", () => {
    expect(normaliseBaseURL("https://cpa.example.com")).toBe("https://cpa.example.com/v1")
    expect(normaliseBaseURL(" https://cpa.example.com/v1/ ")).toBe("https://cpa.example.com/v1")
    expect(normaliseBaseURL("http://192.168.2.5:8317/v1")).toBe("http://192.168.2.5:8317/v1")
    for (const bad of ["cpa.example.com", "ftp://x/v1", "https://u:p@x/v1", "https://x/v1?key=1", "https://x/v1#a"]) expect(normaliseBaseURL(bad)).toBeUndefined()
  })

  test("the key only goes to the CPA origin, and discovery sends none", async () => {
    const seen: { url: string; auth?: string }[] = []
    const fetchFn: Fetch = async (url, init) => {
      const auth = (init?.headers as Record<string, string>)?.Authorization
      seen.push({ url, auth })
      const u = new URL(url)
      if (u.pathname === "/v0/resource/plugins/pacer/events" && !u.search)
        return Response.json({ protocol: 1, pacer: true, client: { version: 1, request_header: "X-Pacer-Client", caps: ["quota"], quota_header: "X-Pacer-Quota", views: ["usage", "prices"] } })
      if (u.searchParams.get("view") === "usage")
        return Response.json({ protocol: 1, view: "usage", now: 1000, credentials: [{ id: "a", alias: "A", provider: "claude", shared_with: [], windows: [{ scope: "all", seconds: 18000, left: 50, state: "current", applies: true }] }] })
      if (u.searchParams.get("view") === "prices")
        return Response.json({ protocol: 1, view: "prices", unit: "usd_per_million_tokens", models: { "claude-opus-5-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, source: "imported" } } })
      if (u.pathname === "/v1/models")
        return Response.json({ object: "list", schema: "cliproxyapi.model-details/1", data: [{ id: "claude-opus-5-5", owned_by: "anthropic", kind: "chat", providers: ["claude"], context_length: 1000000, max_completion_tokens: 128000, reasoning: { mode: "levels", levels: ["low", "high", "max", "bogus"] } }] })
      return new Response("no", { status: 404 })
    }
    const conn = { baseURL: "https://cpa.example.com/v1", key: "k-123" }
    expect((await discover(fetchFn, conn.baseURL)).pacer).toBe(true)
    const view = await usage(fetchFn, conn)
    expect(view.now_ms).toBe(1_000_000)
    expect(view.credentials[0].windows[0].left).toBe(50)
    const p = await prices(fetchFn, conn)
    expect(p["claude-opus-5-5"].source).toBe("imported")
    const cat = withPrices(parseCatalogue(await models(fetchFn, conn)), p)
    expect(cat.source).toBe("details")
    expect(cat.models[0].reasoning).toEqual({ mode: "levels", levels: ["low", "high", "max"] })
    expect(costOf(cat.models[0].price)).toEqual({ input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 })
    for (const s of seen) {
      expect(new URL(s.url).origin).toBe("https://cpa.example.com")
      if (s.url.endsWith("/v0/resource/plugins/pacer/events")) expect(s.auth).toBeUndefined()
      else expect(s.auth).toBe("Bearer k-123")
    }
  })

  test("a CPA without Pacer is not Pacer", async () => {
    const fetchFn: Fetch = async () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } })
    expect(await discover(fetchFn, "https://cpa.example.com/v1")).toEqual({ pacer: false, views: [] })
  })

  test("plain model list", () => {
    const cat = parseCatalogue({ details: false, data: [{ id: "gpt-image-2", owned_by: "openai" }, { id: "m" }, { id: "" }, 5] })
    expect(cat.models.map((m) => [m.id, m.kind, m.reasoning.mode])).toEqual([
      ["gpt-image-2", "image", "none"],
      ["m", "chat", "passthrough"],
    ])
  })
})

describe("meter", () => {
  const reply = (auth: string, at: number, left: number): QuotaReply => ({ v: 1, provider: "claude", auth, alias: auth.toUpperCase(), at_ms: at, windows: [{ scope: "all", seconds: 18000, left, reset_ms: at + 3_600_000, state: "current", applies: true }] })

  test("newer readings win, whichever way they came", () => {
    const m = new Meter()
    m.applyView({ now_ms: 1000, credentials: [{ id: "a", alias: "A", provider: "claude", shared_with: ["b"], windows: [{ scope: "all", seconds: 18000, left: 90, state: "current", applies: true }] }] })
    m.applyReply(reply("a", 2000, 40), "chat-1")
    expect(m.rows()[0].windows[0].left).toBe(40)
    expect(m.rows()[0].shared_with).toEqual(["b"])
    // An older view does not undo the reply, but updates names.
    m.applyView({ now_ms: 1500, credentials: [{ id: "a", alias: "Renamed", provider: "claude", shared_with: [], windows: [{ scope: "all", seconds: 18000, left: 90, state: "current", applies: true }] }] })
    expect(m.rows()[0].windows[0].left).toBe(40)
    expect(m.rows()[0].alias).toBe("Renamed")
    expect(m.lastServed("chat-1")).toEqual({ auth: "a", at_ms: 2000 })
    m.applyReply(reply("b", 1900, 70), "chat-1")
    expect(m.lastServed("chat-1")?.auth).toBe("a")
  })

  test("snapshots merge across processes", () => {
    const writer = new Meter()
    writer.applyReply(reply("a", 5000, 33), "chat")
    const reader = new Meter()
    reader.applyReply(reply("a", 4000, 50))
    let notified = 0
    reader.subscribe(() => notified++)
    reader.restore(JSON.parse(JSON.stringify(writer.snapshot())))
    expect(reader.rows()[0].windows[0].left).toBe(33)
    expect(reader.lastServed("chat")?.auth).toBe("a")
    expect(notified).toBe(1)
  })

  test("labels, countdowns and states", () => {
    expect([18000, 604800, 2592000, 5400].map(durationLabel)).toEqual(["5h", "7d", "30d", "90m"])
    const now = 1_000_000_000
    expect(countdown(now + 37 * 60_000, now)).toBe("37m")
    expect(countdown(now + (4 * 60 + 12) * 60_000, now)).toBe("4h 12m")
    expect(countdown(now + (3 * 24 + 4) * 3_600_000, now)).toBe("3d 4h")
    expect(countdown(now - 1, now)).toBe("reset due")
    expect(windowLine({ scope: "opus", seconds: 604800, left: 9.9, reset_ms: now + 60_000, reset_quality: "estimated", state: "estimated", applies: true }, now)).toEqual({ label: "7d", scope: "opus", left: 9, severity: "error", reset: "~1m" })
    // A reset that passed is never shown as a full new window.
    expect(windowLine({ scope: "all", seconds: 18000, left: 0, reset_ms: now - 5, state: "current", applies: true }, now)).toMatchObject({ left: 0, reset: "reset due", severity: "error" })
    expect(windowLine({ scope: "all", seconds: 18000, left: 15, state: "stale", applies: true }, now)).toMatchObject({ note: "stale", severity: "warning" })
    expect(bar(50, 10)).toBe("█████░░░░░")
    expect(bar(undefined, 3)).toBe("···")
  })
})
