import { expect, test } from "bun:test"
import { setup } from "../src/v2/server.js"

/** The host members setup() uses; storage holds a catalogue saved for this CPA before Pacer was seen. */
function host(baseURL: string) {
  const storage = new Map<string, unknown>([["catalogue", { baseURL, catalogue: { source: "details", models: [] }, pacer: false, views: [] }]])
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
    session: { hook: noop },
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
