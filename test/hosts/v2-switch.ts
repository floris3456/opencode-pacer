// Real stock OpenCode 2.x with this plugin, against a fake CPA whose Pacer
// moves the chat to another account with `compact_on_switch`. Checks that the
// refused step is summarised by Claude Haiku, then rerun on the chat's own
// model with that summary as its checkpoint, and that OpenCode's summary
// agent is back to the user's own model afterwards.
// Usage: bun test/hosts/v2-switch.ts <path to the opencode 2.x binary>
// Prints a JSON result and exits non-zero when a check fails.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fakeCPA } from "../fake-cpa.js"

const [bin] = process.argv.slice(2)
if (!bin) throw new Error("usage: v2-switch.ts <opencode>")
const KEY = "sk-host-test-0123456789"
const refuseAgain = process.env.REFUSE_AGAIN === "1"
const sessionID = `ses_pacerpreview${Math.random().toString(16).slice(2)}`
const cpa = fakeCPA({ key: KEY, pacer: true, accountSwitch: true, refuseAgain,
  primaryStreamDelayMs: 3000,
  nextUse: () => ({ v: 1, at_ms: Date.now(), expires_ms: Date.now() + 30000, mode: "dry-run", provider: "claude", model: "claude-opus-5-5", reason: "cold_move", auth: "claude-next.json", alias: "Next", forced: false }),
  quota: (req) => Buffer.from(JSON.stringify({ v: 1, at_ms: Date.now(), provider: "claude", auth: req.headers.get("x-quota-handoff") ? "claude-a.json" : "claude-aux.json", windows: [{ scope: "all", seconds: 18000, left: 37.5, state: "current", applies: true }] })).toString("base64url"),
})

const home = await fs.mkdtemp(path.join(os.tmpdir(), "oc-v2-switch-"))
const env: Record<string, string> = {
  ...(process.env as Record<string, string>),
  HOME: home,
  PWD: home,
  XDG_CONFIG_HOME: path.join(home, "config"),
  XDG_DATA_HOME: path.join(home, "data"),
  XDG_CACHE_HOME: path.join(home, "cache"),
  XDG_STATE_HOME: path.join(home, "state"),
  OPENCODE_DISABLE_AUTOUPDATE: "1",
}
const config = path.join(env.XDG_CONFIG_HOME, "opencode")
await fs.mkdir(config, { recursive: true })
await fs.writeFile(
  path.join(config, "opencode.json"),
  JSON.stringify({ $schema: "https://opencode.ai/config.json", plugins: [path.resolve(import.meta.dir, "../..")] }),
)
// A private background service on its own port, so CLI calls share one server.
await fs.writeFile(path.join(config, "service.json"), JSON.stringify({ port: 49400 + Math.floor(Math.random() * 100) }))

const run = async (args: string[]) => {
  const p = Bun.spawn([bin, ...args], { env, cwd: home, stdout: "pipe", stderr: "pipe" })
  const timer = setTimeout(() => p.kill(), Number(process.env.RUN_TIMEOUT_MS ?? 180_000))
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited])
  clearTimeout(timer)
  return { out, err, code }
}

const checks: Record<string, boolean> = {}
const connect = JSON.stringify({ key: KEY, answer: { baseURL: cpa.url + "/v1" }, label: "fake" })
let connected = await run(["api", "integration.connect.key", "--param", "integrationID=cliproxyapi", "-d", connect])
// The integration exists once the plugin has loaded in this location.
for (let i = 0; i < 20 && connected.code !== 0; i++) {
  await Bun.sleep(1000)
  connected = await run(["api", "integration.connect.key", "--param", "integrationID=cliproxyapi", "-d", connect])
}
checks.connected = connected.code === 0

const before = await run(["api", "agent.get", "--param", "agentID=compaction"])
let finished = false
const pending = run(["run", "-s", sessionID, "-m", "cliproxyapi/claude-opus-5-5", "--format", "json", "Reply with exactly: pong"]).finally(() => { finished = true })
if (!refuseAgain) {
  checks.in_use_during_stream = false
  while (!finished) {
    if (cpa.seen.some((request) => request.claim?.kind === "primary" && request.status === 200)) {
      const live = await run(["api", "rpc.call", "--param", "rpcID=opencode-pacer", "--param", "method=snapshot", "-d", '{"input":{}}'])
      if (live.code === 0 && JSON.parse(live.out).output?.activity?.[sessionID]?.auth === "claude-a.json") {
        checks.in_use_during_stream = true
        break
      }
    }
    await Bun.sleep(100)
  }
}
const result = await pending
const events = result.out
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line) as { type: string; part?: { text?: string }; error?: { message?: string } })
const agent = await run(["api", "agent.get", "--param", "agentID=compaction"])
const meter = await run(["api", "rpc.call", "--param", "rpcID=opencode-pacer", "--param", "method=snapshot", "-d", '{"input":{}}'])
const next = await run(["api", "rpc.call", "--param", "rpcID=opencode-pacer", "--param", "method=nextUse", "-d", JSON.stringify({ input: { sessionID } })])
await run(["service", "stop"])
cpa.stop()

const models = cpa.seen.filter((s) => s.path.startsWith("/v1/messages"))
const refusal = models.findIndex((s) => s.status === 409)
const after = models.slice(refusal + 1)
const summaries = after.filter((s) => s.model === "claude-haiku-5-5")
const rerun = after.find((s) => s.model === "claude-opus-5-5" && s.claim?.kind === "primary")
checks.step_claimed_and_refused = refusal >= 0 && models[refusal]?.claim?.compact_on_switch === true
checks.capability_is_a_digest = /^[a-f0-9]{64}$/.test(String(models[refusal]?.claim?.capability ?? ""))
checks.one_summary_by_haiku = summaries.length === 1 && summaries[0]!.claim === undefined
checks.rerun_on_opus_with_new_checkpoint =
  rerun?.status === (refuseAgain ? 409 : 200) && typeof rerun.claim?.checkpoint === "string" && rerun.claim.checkpoint !== ""
checks.expected_outcome = refuseAgain
  ? events.some((e) => e.type === "error" && e.error?.message?.includes("refused this chat again")) && after.filter((s) => s.claim?.kind === "primary").length === 1
  : events.some((e) => e.type === "text" && e.part?.text?.includes("pong")) && !events.some((e) => e.type === "error")
const restored = (() => {
  try {
    const original = JSON.parse(before.out) as { data?: { id?: string; model?: unknown } }
    const current = JSON.parse(agent.out) as { data?: { id?: string; model?: unknown } }
    return before.code === 0 && original.data?.id === "compaction" && current.data?.id === "compaction" && JSON.stringify(current.data.model) === JSON.stringify(original.data.model)
  } catch {
    return false
  }
})()
checks.summary_agent_restored = agent.code === 0 && restored
if (!refuseAgain) {
  const snapshot = JSON.parse(meter.out).output
  const preview = JSON.parse(next.out).output
  checks.live_response_percentage = snapshot?.credentials?.find((row: { id: string }) => row.id === "claude-a.json")?.windows?.[0]?.left === 37.5
  checks.last_used_primary = snapshot?.served?.[sessionID]?.auth === "claude-a.json"
  checks.in_use_cleared_after_turn = snapshot?.activity?.[sessionID] !== undefined && snapshot.activity[sessionID].auth === undefined
  checks.server_preview = preview?.auth === "claude-next.json" && preview?.mode === "dry-run"
}

const ok = Object.values(checks).every(Boolean)
console.log(
  JSON.stringify(
    {
      ok,
      checks,
      requests: models.map((s) => `${s.status} ${s.model}${s.claim ? ` [${s.claim.kind} checkpoint=${s.claim.checkpoint || "-"}]` : ""}`),
      events: events.map((e) => e.type + (e.error?.message ? `: ${e.error.message}` : "")),
      compaction_agent: agent.out.slice(0, 400),
      meter: ok ? undefined : meter.out,
      declarations: ok ? undefined : models.map((s) => s.headers["x-pacer-client"]),
      stderr_tail: ok ? undefined : (connected.err + result.err).slice(-3000),
    },
    null,
    2,
  ),
)
if (ok) await fs.rm(home, { recursive: true, force: true })
else console.error(`Test diagnostics retained at ${home}`)
process.exit(ok ? 0 : 1)
