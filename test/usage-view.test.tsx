import { afterEach, expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/tui/context"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import { createRoot, createSignal } from "solid-js"
import { createUsage } from "../src/v2/usage-view.js"
import { Meter } from "../src/core/meter.js"
import type { PacerMeterEvent } from "../src/rpc.js"
import type { NextUse } from "../src/core/protocol.js"

type Layer = ReturnType<Parameters<Context["keymap"]["layer"]>[0]>
const cleanups: (() => void)[] = []
afterEach(() => cleanups.splice(0).reverse().forEach((fn) => fn()))

function fixture() {
  const [model, setModel] = createSignal({ providerID: "cliproxyapi", modelID: "claude-sonnet" })
  const [dialog, setDialog] = createSignal<() => JSX.Element>()
  const [status, setStatus] = createSignal<"idle" | "running">("idle")
  const meter = new Meter()
  const now = Date.now()
  meter.applyView({ now_ms: now, credentials: Array.from({ length: 10 }, (_, index) => ({
    id: `account-${index}`, alias: `Account ${index}`, provider: index ? "codex" : "claude", shared_with: [],
    windows: [{ scope: "all", seconds: 18000, left: 61 - index, reset_ms: now + 3600000, read_ms: now, state: "current", applies: true }],
  })) })
  const state = {
    slots: new Map<string, () => JSX.Element>(), layers: [] as Layer[],
    listeners: new Set<(event: { data: PacerMeterEvent }) => void>(),
    next: undefined as NextUse | undefined,
  }
  const color = RGBA.fromHex("#cccccc")
  const token = { base: color, selected: color, hovered: color }
  const context = {
    theme: { text: { base: color, muted: color, formfield: token, action: { primary: token, secondary: token }, feedback: { warning: token, error: token, success: token, info: token } }, background: { raised: token }, border: token, scrollbar: token },
    location: { directory: "/fixture" },
    data: { session: { get: () => ({ location: { directory: "/fixture" } }), status } },
    client: { rpc: () => ({
      usage: async (input: { providerID: string; modelID: string }) => ({ snapshot: meter.snapshot(), providers: input.providerID !== "cliproxyapi" ? [] : input.modelID.startsWith("claude") ? ["claude"] : ["codex"] }),
      nextUse: async () => state.next ?? {},
      events: { on: (_name: string, listener: (event: { data: PacerMeterEvent }) => void) => { state.listeners.add(listener); return () => state.listeners.delete(listener) } },
    }) },
    keymap: { layer: (factory: () => Layer) => state.layers.push(factory()), dispatch: () => {} },
    ui: {
      slot: (claim: { append: string; render: () => JSX.Element }) => { state.slots.set(claim.append, claim.render); return () => state.slots.delete(claim.append) },
      model: { current: model }, router: { current: () => ({ type: "session", sessionID: "ses_a" }) },
      dialog: { show: (view: () => JSX.Element) => setDialog(() => view), clear: () => setDialog(undefined), set: () => {} }, toast: { show: () => {} },
    },
  } as unknown as Context
  cleanups.push(createUsage(context, { interval: 60000 }))
  createRoot((dispose) => { state.slots.get("app")!(); cleanups.push(dispose) })
  const command = (id: string) => state.layers.flatMap((layer) => layer.commands ?? []).findLast((command) => command.id === id)!
  const push = () => state.listeners.forEach((listener) => listener({ data: { snapshot: meter.snapshot() } }))
  return { state, dialog, setModel, setStatus, command, meter, push }
}
async function mount(f: ReturnType<typeof fixture>, width = 80, height = 24) {
  const output = await createTestRenderer({ width, height })
  render(() => <box><box width={37}>{f.state.slots.get("sidebar.content")!()}</box><box position="absolute" top={0} left={0} width={width} height={f.dialog() ? height : 0} backgroundColor={f.dialog() ? "#000000" : undefined}>{f.dialog()?.()}</box></box>, output.renderer)
  cleanups.push(() => output.renderer.destroy())
  return output
}
async function frame(output: Awaited<ReturnType<typeof createTestRenderer>>) {
  await Bun.sleep(15)
  await output.renderOnce()
  return output.captureCharFrame()
}

test("1.3.5 compact format and catalogue filtering before the first request", async () => {
  const f = fixture()
  const output = await mount(f)
  const text = await frame(output)
  expect(text).toContain("Account 0 · claude")
  expect(text).toContain("████████████░░░░░░░░  61%")
  expect(text).not.toContain("Account 1")
  expect(text.split("\n").filter((line) => line.trim())).toHaveLength(3)
  f.setModel({ providerID: "cliproxyapi", modelID: "gpt-5" })
  const switched = await frame(output)
  expect(switched).toContain("Account 1 · codex")
  expect(switched).not.toContain("Account 0")
  f.setModel({ providerID: "other", modelID: "gpt-5" })
  expect((await frame(output)).trim()).toBe("")
})

test("usage popup preserves scope, details, paging and escape without widening the sidebar", async () => {
  const f = fixture()
  const output = await mount(f, 80, 24)
  await frame(output)
  f.command("pacer.usage.open").run("--all")
  let text = await frame(output)
  expect(text).toContain("Credential usage")
  expect(text).toContain("All credentials")
  expect(text).toContain("Account 1")
  expect(text).toContain("d details")
  const first = text
  f.command("pacer.usage.next").run()
  text = await frame(output)
  expect(text).not.toBe(first)
  f.command("pacer.usage.details").run()
  text = await frame(output)
  expect(text).toContain("account-0")
  expect(text).toContain("5 hours · 61% left · resets")
  f.command("pacer.usage.scope").run()
  text = await frame(output)
  expect(text).toContain("Selected model’s providers")
  expect(text).not.toContain("Account 1")
  f.command("pacer.usage.close").run()
  text = await frame(output)
  expect(text).not.toContain("Credential usage")
  expect(text).not.toContain("Account 1")
})

test("live response pushes update compact percentages and replace LAST USED with IN USE", async () => {
  const f = fixture()
  const output = await mount(f)
  await frame(output)
  f.setStatus("running")
  const now = Date.now()
  f.meter.applyReply({ v: 1, auth: "account-0", provider: "claude", at_ms: now,
    windows: [{ scope: "all", seconds: 18000, left: 37.5, reset_ms: now + 3600000, state: "current", applies: true }] }, "ses_a", true)
  f.push()
  const active = await frame(output)
  expect(active).toContain("37%")
  expect(active).toContain("IN USE")
  expect(active).not.toContain("LAST USED")
  f.meter.endActivity("ses_a")
  f.push()
  f.setStatus("idle")
  const idle = await frame(output)
  expect(idle).toContain("LAST USED")
  expect(idle).not.toContain("IN USE")
})

test("NEXT USE follows the selected model and the narrow popup remains paged", async () => {
  const f = fixture()
  f.setModel({ providerID: "cliproxyapi", modelID: "gpt-5" })
  f.state.next = { v: 1, at_ms: Date.now(), expires_ms: Date.now() + 30000, mode: "dry-run", provider: "codex", model: "gpt-5", auth: "account-1", reason: "cold_move", forced: false }
  const output = await mount(f, 45, 16)
  expect(await frame(output)).toContain("NEXT USE")
  f.command("pacer.usage.open").run()
  const popup = await frame(output)
  expect(popup).toContain("Credential usage")
  expect(popup).toContain("1/")
  f.command("pacer.usage.close").run()
  f.setModel({ providerID: "cliproxyapi", modelID: "claude-sonnet" })
  expect(await frame(output)).not.toContain("NEXT USE")
})
