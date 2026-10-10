import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import plugin from "../src/v1/server.js"
import { PLACEHOLDER_MODEL } from "../src/v1/provider.js"
import { loadMeter } from "../src/v1/files.js"
import { fakeCPA } from "./fake-cpa.js"

const KEY = "sk-test-0123456789"
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")

let home: string
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-pacer-"))
  process.env.XDG_DATA_HOME = path.join(home, "data")
  process.env.XDG_CACHE_HOME = path.join(home, "cache")
  delete process.env.OPENCODE_AUTH_CONTENT
})
afterEach(async () => {
  delete process.env.OPENCODE_AUTH_CONTENT
  await fs.rm(home, { recursive: true, force: true })
})

const connect = (baseURL: string) => {
  process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ cliproxyapi: { type: "api", key: KEY, metadata: { baseURL } } })
}

async function hooks() {
  return plugin.server({} as never, {})
}

async function configured() {
  const cfg: Record<string, any> = { provider: {} }
  await (await hooks()).config!(cfg as never)
  return cfg.provider.cliproxyapi
}

describe("stock opencode 1.x server half", () => {
  test("before /connect: a placeholder keeps CLIProxyAPI listed", async () => {
    const p = await configured()
    expect(p.name).toBe("CLIProxyAPI")
    expect(p.npm).toBe("@ai-sdk/openai-compatible")
    expect(Object.keys(p.models)).toEqual([PLACEHOLDER_MODEL])
  })

  test("models and Pacer's prices come from CPA; Claude goes through the Messages relay", async () => {
    const cpa = fakeCPA({ key: KEY, pacer: true })
    try {
      connect(cpa.url + "/v1")
      const p = await configured()
      expect(p.options.baseURL).toBe(cpa.url + "/v1")
      expect(Object.keys(p.models).sort()).toEqual(["claude-opus-5-5", "gpt-6-sol"])
      const claude = p.models["claude-opus-5-5"]
      expect(claude.provider).toEqual({ npm: "@ai-sdk/anthropic", api: cpa.url + "/v1" })
      expect(claude.cost).toEqual({ input: 5, output: 25, cache_read: 0.5, cache_write: 6.25 })
      expect(claude.limit).toEqual({ context: 1000000, output: 128000 })
      expect(claude.attachment).toBe(true)
      const gpt = p.models["gpt-6-sol"]
      expect(gpt.limit).toEqual({ context: 400000, output: 128000, input: 272000 })
      expect(gpt.variants.xhigh).toEqual({ reasoningEffort: "xhigh" })
      expect(gpt.variants.max).toEqual({ disabled: true })
      // Claude: opencode spells thinking; CPA's levels stay on, the rest off.
      expect(claude.variants).toEqual({ none: { disabled: true }, minimal: { disabled: true }, medium: { disabled: true }, xhigh: { disabled: true } })
      expect(gpt.cost).toEqual({ input: 2, output: 8, cache_read: 0, cache_write: 0 })
    } finally {
      cpa.stop()
    }
  })

  test("the user's own settings win; without CPA the last catalogue is used", async () => {
    const cpa = fakeCPA({ key: KEY, pacer: false })
    connect(cpa.url + "/v1")
    const first = await configured()
    expect(first.models["claude-opus-5-5"].cost).toBeUndefined()
    cpa.stop()
    const cfg: Record<string, any> = { provider: { cliproxyapi: { name: "My CPA", models: { "gpt-6-sol": { name: "Sol" }, mine: { name: "Mine" } } } } }
    await (await hooks()).config!(cfg as never)
    const p = cfg.provider.cliproxyapi
    expect(p.name).toBe("My CPA")
    expect(p.models["gpt-6-sol"].name).toBe("Sol")
    expect(p.models["gpt-6-sol"].variants.high).toEqual({ reasoningEffort: "high" })
    expect(p.models.mine).toEqual({ name: "Mine" })
  })

  test("model requests declare the client to Pacer and the reply's quota reaches the meter", async () => {
    const reply = (req: Request) => b64url({ v: 1, provider: "claude", auth: "claude-a.json", alias: "A", at_ms: Date.now(), windows: [{ scope: "all", seconds: 18000, left: 42, reset_ms: Date.now() + 7_200_000, state: "current", applies: true }] })
    const cpa = fakeCPA({ key: KEY, pacer: true, quota: reply })
    try {
      const h = await hooks()
      const options = await h.auth!.loader!(async () => ({ type: "api", key: KEY, metadata: { baseURL: cpa.url + "/v1" } }) as never, {} as never)
      expect(options.baseURL).toBe(cpa.url + "/v1")
      expect(options.apiKey).toBe(KEY)
      const f = options.fetch as typeof fetch
      // Discovery runs in the background; wait for it.
      await Bun.sleep(100)
      const res = await f(cpa.url + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}`, "X-Session-Id": "ses_1" }, body: "{}" })
      expect(res.status).toBe(200)
      const sent = cpa.seen.find((s) => s.path === "/v1/chat/completions")!
      expect(sent.headers["x-pacer-client"]).toBe("v=1; caps=quota")
      await h.dispose!()
      const snapshot = await loadMeter()
      expect(snapshot?.credentials[0].windows[0].left).toBe(42)
      expect(snapshot?.served.ses_1.auth).toBe("claude-a.json")
    } finally {
      cpa.stop()
    }
  })

  test("no declaration without Pacer, nor to other hosts", async () => {
    const cpa = fakeCPA({ key: KEY, pacer: false })
    const other = fakeCPA({ key: KEY, pacer: true })
    try {
      const h = await hooks()
      const options = await h.auth!.loader!(async () => ({ type: "api", key: KEY, metadata: { baseURL: cpa.url + "/v1" } }) as never, {} as never)
      await Bun.sleep(100)
      const f = options.fetch as typeof fetch
      await f(cpa.url + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: "{}" })
      await f(other.url + "/v1/chat/completions", { method: "POST", headers: { Authorization: `Bearer ${KEY}` }, body: "{}" })
      expect(cpa.seen.find((s) => s.path === "/v1/chat/completions")!.headers["x-pacer-client"]).toBeUndefined()
      expect(other.seen.find((s) => s.path === "/v1/chat/completions")!.headers["x-pacer-client"]).toBeUndefined()
      // Anything other than an API key with a URL is not a connection.
      expect(await h.auth!.loader!(async () => ({ type: "api", key: KEY }) as never, {} as never)).toEqual({})
    } finally {
      cpa.stop()
      other.stop()
    }
  })
})
