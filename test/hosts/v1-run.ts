// Real stock opencode 1.x with this plugin, against a fake CPA with Pacer.
// Usage (inside a container, see test/hosts/README.md):
//   bun test/hosts/v1-run.ts <path to the opencode binary> <model>
// Prints a JSON result and exits non-zero when a check fails.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fakeCPA } from "../fake-cpa.js"

const [bin, model = "gpt-6-sol"] = process.argv.slice(2)
if (!bin) throw new Error("usage: v1-run.ts <opencode> [model]")
const KEY = "sk-host-test-0123456789"
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
const cpa = fakeCPA({
  key: KEY,
  pacer: true,
  quota: () => b64url({ v: 1, provider: "codex", auth: "codex-a.json", alias: "Codex A", at_ms: Date.now(), windows: [{ scope: "all", seconds: 604800, left: 64, reset_ms: Date.now() + 3 * 86_400_000, state: "current", source: "header", applies: true }] }),
})

const home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-v1-"))
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
  OPENCODE_DISABLE_MODELS_FETCH: "1",
}
await fs.mkdir(path.join(env.XDG_CONFIG_HOME, "opencode"), { recursive: true })
await fs.mkdir(path.join(env.XDG_DATA_HOME, "opencode"), { recursive: true })
const plugin = path.resolve(import.meta.dir, "../../src/v1/server.ts")
await fs.writeFile(path.join(env.XDG_CONFIG_HOME, "opencode", "opencode.json"), JSON.stringify({ $schema: "https://opencode.ai/config.json", plugin: [plugin], autoupdate: false, share: "disabled" }))
await fs.writeFile(path.join(env.XDG_DATA_HOME, "opencode", "auth.json"), JSON.stringify({ cliproxyapi: { type: "api", key: KEY, metadata: { baseURL: cpa.url + "/v1" } } }), { mode: 0o600 })

const run = async (args: string[]) => {
  const p = Bun.spawn([bin, ...args], { env, cwd: home, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => p.kill(), Number(process.env.RUN_TIMEOUT_MS ?? 120_000))
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { out, err, code }
}

const checks: Record<string, boolean> = {}
const listed = await run(["models", "cliproxyapi", "--verbose"])
checks.models_listed = listed.out.includes(`cliproxyapi/${model}`) && listed.out.includes("cliproxyapi/claude-opus-5-5")
checks.image_model_hidden = !listed.out.includes("gpt-image-2")
checks.pacer_price_in_catalogue = /"input":\s*5[,\s]/.test(listed.out) || listed.out.includes('"input": 5')
// Variants opencode offers for Claude: only the levels CPA accepts (low, high, max).
const claudeJSON = listed.out.slice(listed.out.indexOf("cliproxyapi/claude-opus-5-5"))
const variants = (() => {
  try {
    const start = claudeJSON.indexOf("{")
    let depth = 0
    for (let i = start; i < claudeJSON.length; i++) {
      if (claudeJSON[i] === "{") depth++
      if (claudeJSON[i] === "}" && --depth === 0) return Object.keys(JSON.parse(claudeJSON.slice(start, i + 1)).variants ?? {})
    }
  } catch {}
  return []
})()
checks.claude_variants_follow_cpa = JSON.stringify(variants.sort()) === JSON.stringify(["high", "low", "max"])
const result = await run(["run", "--print-logs", "--log-level", "DEBUG", "--model", `cliproxyapi/${model}`, "Say pong"])
const chat = cpa.seen.filter((s) => s.path.startsWith("/v1/chat/completions") || s.path.startsWith("/v1/messages"))
checks.reply_shown = result.out.includes("pong")
checks.request_reached_cpa = chat.length > 0
checks.declared = chat.length > 0 && chat.every((s) => s.headers["x-pacer-client"] === "v=1; caps=quota")
checks.key_sent = chat.every((s) => s.headers.authorization === `Bearer ${KEY}` || s.headers["x-api-key"] === KEY)
await Bun.sleep(500)
let meter: any
try {
  meter = JSON.parse(await fs.readFile(path.join(env.XDG_CACHE_HOME, "opencode-pacer", "meter.json"), "utf8"))
} catch {}
checks.meter_written = meter?.credentials?.[0]?.windows?.[0]?.left === 64
checks.session_marked = Object.values(meter?.served ?? {}).some((s: any) => s.auth === "codex-a.json")
cpa.stop()
const ok = Object.values(checks).every(Boolean)
console.log(
  JSON.stringify(
    { ok, model, checks, run_code: result.code, requests: cpa.seen.map((s) => `${s.method} ${s.path.split("?")[0]}${s.headers["x-pacer-client"] ? " [declared]" : ""}`), stderr_tail: ok ? undefined : (result.err + listed.err).slice(-3000), stdout_tail: ok ? undefined : (listed.out + result.out).slice(-3000) },
    null,
    2,
  ),
)
await fs.rm(home, { recursive: true, force: true })
process.exit(ok ? 0 : 1)
