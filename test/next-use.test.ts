import { expect, test } from "bun:test"
import { chatUsage } from "../src/core/cpa.js"
import { parseNextUse, parseUsage } from "../src/core/protocol.js"
import { Meter } from "../src/core/meter.js"

const preview = {
  v: 1, at_ms: 1000, expires_ms: 31000, candidates_at_ms: 500,
  provider: "claude", model: "claude-opus-5-5", mode: "dry-run",
  auth: "b", alias: "Next", reason: "cold_move", forced: false,
} as const

test("preview is server-owned, optional and distinct from the last serving account", () => {
  expect(parseNextUse(preview)).toEqual(preview)
  expect(parseNextUse({ ...preview, mode: "off" })).toBeUndefined()
  expect(parseNextUse({ ...preview, reason: "protected" })).toBeUndefined()
  expect(parseNextUse({ ...preview, expires_ms: 1 })).toBeUndefined()
  expect(parseNextUse({ ...preview, v: 2 })).toBeUndefined()
  expect(parseNextUse({ ...preview, auth: undefined, alias: undefined, reason: "protected" })).toMatchObject({ reason: "protected" })
  expect(parseUsage({ view: "usage", now: 1, credentials: [] })?.next_use).toBeUndefined()
  expect(parseUsage({ view: "usage", now: 1, credentials: [], next_use: preview })?.next_use?.auth).toBe("b")
  expect(parseUsage({ view: "usage", now: 1, credentials: [], active: ["a", 7, "b"] })?.active).toEqual(["a", "b"])
  expect(parseUsage({ view: "usage", now: 1, credentials: [], active: [] })?.active).toEqual([])
})

test("chat usage sends only the existing private capability to the configured CPA origin", async () => {
  const result = await chatUsage(async (url, init) => {
    const request = new URL(url)
    expect(request.origin).toBe("https://cpa.example")
    expect(request.searchParams.get("model")).toBe("cliproxyapi/claude-opus-5-5")
    expect(request.searchParams.has("auth")).toBe(false)
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer private-chat-capability")
    expect(init?.redirect).toBe("error")
    return Response.json({ view: "usage", now: 1, credentials: [], next_use: preview })
  }, "https://cpa.example/v1", "private-chat-capability", "cliproxyapi/claude-opus-5-5")
  expect(result.next_use?.auth).toBe("b")
})

test("a request updates all shared quota meters immediately, without moving LAST USED on auxiliary replies", () => {
  const meter = new Meter()
  meter.applyView({ now_ms: 1000, credentials: [
    { id: "a", alias: "A", provider: "claude", shared_with: ["a-alias"], windows: [] },
    { id: "a-alias", alias: "Alias", provider: "claude", shared_with: ["a"], windows: [] },
    { id: "b", alias: "B", provider: "claude", shared_with: [], windows: [] },
  ] })
  let notified = 0
  meter.subscribe(() => notified++)
  meter.applyReply({ v: 1, auth: "a", provider: "claude", at_ms: 2000, windows: [{ scope: "all", seconds: 18000, left: 38.25, applies: true, state: "current" }] }, "chat")
  expect(notified).toBe(1)
  expect(meter.rows().filter((row) => row.id !== "b").map((row) => row.windows[0].left)).toEqual([38.25, 38.25])
  meter.applyReply({ v: 1, auth: "b", provider: "claude", at_ms: 3000, windows: [{ scope: "all", seconds: 18000, left: 72, applies: true, state: "current" }] })
  expect(meter.lastServed("chat")?.auth).toBe("a")
  expect(meter.rows().find((row) => row.id === "b")?.windows[0].left).toBe(72)
  meter.applyReply({ v: 1, auth: "a", provider: "claude", at_ms: 1500, windows: [] })
  expect(meter.rows().find((row) => row.id === "a-alias")?.windows[0].left).toBe(38.25)
})
