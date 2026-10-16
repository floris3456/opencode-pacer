import { expect, test } from "bun:test"
import { setup } from "../src/v2/server.js"

/** The host members setup() uses; storage holds a catalogue saved for this CPA, by default before Pacer was seen. */
function host(baseURL: string, options: { pacer?: boolean; hooks?: Map<string, (event: never) => unknown> } = {}) {
  const pacer = options.pacer === true
  const storage = new Map<string, unknown>([["catalogue", { baseURL, catalogue: { source: "details", models: [] }, pacer, views: pacer ? ["usage"] : [] }]])
  const noop = async () => {}
  return {
    app: { version: "test" },
    options: {},
    storage: { get: async (key: string) => storage.get(key), set: async (key: string, value: unknown) => void storage.set(key, value) },
    rpc: { register: async () => ({ events: { emit: noop } }) },
    integration: {
      transform: noop,
      connection: {
        active: async () => ({ type: "credential" }),
        resolve: async () => ({ type: "key", key: "key", configuration: { baseURL } }),
      },
    },
    provider: { transform: noop, reload: noop },
    agent: { transform: noop, reload: noop },
    session: { hook: async (name: string, fn: (event: never) => unknown) => void options.hooks?.set(name, fn) },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }))
        })(),
    },
  }
}

test("a catalogue refresh still running when the plugin is disposed starts no loop", async () => {
  let disposed = false
  let release = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const seen: string[] = []
  const afterDispose: string[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      seen.push(url.pathname)
      if (disposed) afterDispose.push(url.pathname + url.search)
      if (url.pathname === "/v0/resource/plugins/pacer/events" && !req.headers.get("authorization")) {
        await held
        return Response.json({ protocol: 1, pacer: true, client: { version: 1, request_header: "X-Pacer-Client", caps: ["quota"], quota_header: "X-Pacer-Quota", views: ["usage"] } })
      }
      if (url.pathname === "/v0/resource/plugins/pacer/events") return Response.json({ view: "usage", now_ms: Date.now(), credentials: [] })
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [] })
      return new Response("not found", { status: 404 })
    },
  })
  // The catalogue loop's own timers: every 5 minutes, or 15 seconds after a failed read.
  const delays: number[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (disposed) delays.push(ms ?? 0)
    return realSetTimeout(fn, ms, ...args)
  }) as typeof setTimeout
  const until = async (fn: () => boolean) => {
    const deadline = Date.now() + 3000
    while (!fn()) {
      if (Date.now() > deadline) throw new Error("timed out")
      await Bun.sleep(5)
    }
  }
  try {
    const dispose = await setup(host(`http://127.0.0.1:${server.port}/v1`) as never)
    // The first refresh is waiting for discovery, which now reports Pacer.
    await until(() => seen.includes("/v0/resource/plugins/pacer/events"))
    dispose()
    disposed = true
    release()
    await until(() => seen.includes("/v1/models"))
    await Bun.sleep(100)
    expect(afterDispose.filter((path) => path.includes("view=usage"))).toEqual([])
    expect(delays.filter((ms) => ms === 5 * 60_000 || ms === 15_000)).toEqual([])
  } finally {
    globalThis.setTimeout = realSetTimeout
    server.stop(true)
  }
})

test("a discovery CPA did not answer keeps what was known and asks again soon; only an answer changes it", async () => {
  let reply: "fail" | "yes" | "no" = "fail"
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/v0/resource/plugins/pacer/events" && !url.search) {
        if (reply === "fail") return new Response("bad gateway", { status: 502 })
        if (reply === "no") return new Response("not found", { status: 404 })
        return Response.json({ protocol: 1, pacer: true, client: { version: 1, request_header: "X-Pacer-Client", caps: ["quota"], quota_header: "X-Pacer-Quota", views: ["usage"] } })
      }
      if (url.pathname === "/v0/resource/plugins/pacer/events") return Response.json({ view: "usage", now_ms: Date.now(), credentials: [] })
      if (url.pathname === "/v1/models") return Response.json({ object: "list", data: [] })
      return new Response("not found", { status: 404 })
    },
  })
  // The catalogue loop's timers (5 minutes, or 15 seconds after a failed read) are recorded and run by hand.
  const loop: { ms: number; run: () => void }[] = []
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = ((fn: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms === 5 * 60_000 || ms === 15_000) {
      loop.push({ ms, run: () => fn(...args) })
      return 0
    }
    return realSetTimeout(fn, ms, ...args)
  }) as typeof setTimeout
  const realNow = Date.now
  let offset = 0
  Date.now = () => realNow() + offset
  const hooks = new Map<string, (event: never) => unknown>()
  const baseURL = `http://127.0.0.1:${server.port}/v1`
  // Whether a chat request declares the Pacer client, which is what lets Plus claim the chat.
  const declared = () => {
    const event = { baseURL, headers: {} as Record<string, string> }
    hooks.get("model.request")?.(event as never)
    return event.headers["X-Pacer-Client"] !== undefined
  }
  const nextRefresh = async () => {
    const deadline = realNow() + 3000
    const count = loop.length
    if (count) loop[count - 1].run()
    while (loop.length === count) {
      if (realNow() > deadline) throw new Error("timed out")
      await Bun.sleep(5)
    }
    return loop[loop.length - 1].ms
  }
  try {
    // Pacer was seen before this start; the first discovery gets no answer.
    const dispose = await setup(host(baseURL, { pacer: true, hooks }) as never)
    expect(await nextRefresh()).toBe(15_000)
    expect(declared()).toBe(true)
    reply = "yes"
    expect(await nextRefresh()).toBe(5 * 60_000)
    expect(declared()).toBe(true)
    // CPA answers that Pacer is gone.
    reply = "no"
    offset += 5 * 60_000 + 1
    expect(await nextRefresh()).toBe(5 * 60_000)
    expect(declared()).toBe(false)
    // No answer keeps that too.
    reply = "fail"
    offset += 5 * 60_000 + 1
    expect(await nextRefresh()).toBe(15_000)
    expect(declared()).toBe(false)
    dispose()
  } finally {
    globalThis.setTimeout = realSetTimeout
    Date.now = realNow
    server.stop(true)
  }
})
