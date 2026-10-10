// Runs the fake CPA with Pacer until killed; prints its URL. For the TUI checks.
import { fakeCPA } from "../fake-cpa.js"
const key = process.argv[2] ?? "sk-host-test-0123456789"
const b64url = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url")
const cpa = fakeCPA({
  key,
  pacer: true,
  quota: () => b64url({ v: 1, provider: "codex", auth: "codex-a.json", alias: "Codex A", at_ms: Date.now(), windows: [{ scope: "all", seconds: 18000, left: 81, reset_ms: Date.now() + 2 * 3_600_000 + 13 * 60_000, state: "current", source: "header", applies: true }, { scope: "all", seconds: 604800, left: 64, reset_ms: Date.now() + 3 * 86_400_000, state: "current", source: "header", applies: true }] }),
})
console.log(cpa.url)
setInterval(() => {}, 1 << 30)
