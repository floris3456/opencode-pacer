import { expect, test } from "bun:test"
import { watchUsage } from "../src/core/cpa.js"
import { Meter } from "../src/core/meter.js"

test("idle clients receive shared credential changes over held GETs and cancel cleanly", async () => {
  let revision = 1
  let left = 70
  let at = 1800000000123
  const waiting = new Set<() => void>()
  const paths: string[] = []
  const server = Bun.serve({ port: 0, async fetch(req) {
    const url = new URL(req.url)
    paths.push(url.pathname)
    if (url.pathname !== "/v0/resource/plugins/pacer/events") return new Response("unexpected inference", { status: 500 })
    expect(["Bearer user-one", "Bearer user-two"]).toContain(req.headers.get("authorization")!)
    if (url.searchParams.get("cursor") === String(revision)) {
      await new Promise<void>((resolve) => {
        const wake = () => { waiting.delete(wake); req.signal.removeEventListener("abort", wake); resolve() }
        waiting.add(wake)
        req.signal.addEventListener("abort", wake, { once: true })
        if (req.signal.aborted) wake()
      })
    }
    return Response.json({ view: "usage", now: Math.floor(at / 1000), now_ms: at, cursor: String(revision), credentials: [
      { id: "shared", provider: "codex", windows: [{ scope: "all", seconds: 604800, left, read_ms: at, source: "header", state: "current" }] },
    ] })
  } })
  const controllers = [new AbortController(), new AbortController()]
  const meters = [new Meter(), new Meter()]
  const tasks = meters.map((meter, i) => watchUsage(fetch, { baseURL: `http://127.0.0.1:${server.port}/v1`, key: i ? "user-two" : "user-one" }, (v) => meter.applyView(v), controllers[i]!.signal))
  const until = async (fn: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!fn()) { if (Date.now() > deadline) throw new Error("subscription timed out"); await Bun.sleep(5) }
  }
  try {
    await until(() => waiting.size === 2)
    // Header from a third caller updates Pacer. Idle clients make no inference.
    left = 31; at += 100; revision++
    for (const wake of [...waiting]) wake()
    await until(() => meters.every((m) => m.rows()[0]?.windows[0]?.left === 31))
    expect(meters.map((m) => m.rows()[0]?.at_ms)).toEqual([at, at])
    expect(meters.map((m) => m.snapshot().served)).toEqual([{}, {}])
    expect(paths.every((p) => p === "/v0/resource/plugins/pacer/events")).toBe(true)
  } finally {
    controllers.forEach((c) => c.abort())
    for (const wake of [...waiting]) wake()
    await Promise.all(tasks)
    server.stop(true)
  }
})

test("old servers without cursors do not cause a busy request loop", async () => {
  let calls = 0
  const controller = new AbortController()
  const task = watchUsage(async () => {
    calls++
    return Response.json({ view: "usage", now: 1800000000, credentials: [] })
  }, { baseURL: "http://localhost/v1", key: "key" }, () => {}, controller.signal)
  await Bun.sleep(120)
  expect(calls).toBe(1)
  controller.abort()
  await task
})
