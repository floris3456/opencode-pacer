import type { Context } from "@opencode/plugin/tui/context"
import { createEffect, createMemo, createRoot, createSignal, onCleanup } from "solid-js"
import { Meter, type MeterSnapshot } from "../core/meter.js"
import { parseNextUse } from "../core/protocol.js"
import { usageSnapshot, type UsageInput, type UsageSnapshot } from "../core/usage.js"
import { PacerRpc, type PacerMeterEvent } from "../rpc.js"

export function createUsageStore(context: Context, options: { interval?: number } = {}) {
  return createRoot((dispose) => {
    const rpc = context.client.rpc(PacerRpc)
    const meter = new Meter()
    const [revision, setRevision] = createSignal(0)
    const [scope, setScope] = createSignal<"model" | "all">("model")
    const [details, setDetails] = createSignal(false)
    const [views, setViews] = createSignal(0)
    const [clock, setClock] = createSignal(Date.now())
    const [providers, setProviders] = createSignal<readonly string[]>([])
    const [loaded, setLoaded] = createSignal(false)
    const [failure, setFailure] = createSignal<string>()
    const [preview, setPreview] = createSignal<ReturnType<typeof parseNextUse>>()
    const [active, setActive] = createSignal<{ ids: string[]; expires: number }>()
    const input = createMemo<UsageInput | undefined>(() => {
      const model = context.ui.model.current()
      if (!model) return
      const route = context.ui.router.current()
      return { sessionID: route.type === "session" ? route.sessionID : undefined, providerID: model.providerID, modelID: model.modelID, all: scope() === "all" }
    }, undefined, { equals: (a, b) => JSON.stringify(a) === JSON.stringify(b) })
    meter.subscribe(() => setRevision((value) => value + 1))
    const off = rpc.events.on("meter", (event) => {
      meter.restore((event.data as unknown as PacerMeterEvent).snapshot, true)
      setClock(Date.now())
    })
    onCleanup(off)
    createEffect(() => {
      const selected = input()
      if (!views() || !selected) return
      const directory = (selected.sessionID ? context.data.session.get(selected.sessionID)?.location.directory : undefined)
        ?? context.location?.directory ?? context.data.location.default().directory
      setProviders([])
      setLoaded(false)
      setFailure(undefined)
      setPreview(undefined)
      setActive(undefined)
      let disposed = false
      let pending = false
      let previewAt = 0
      const load = async () => {
        if (pending) return
        pending = true
        const value = await rpc.usage({ providerID: selected.providerID, modelID: selected.modelID }, { location: { directory } }).catch(() => undefined)
        if (disposed) return
        if (value) {
          const result = value as { snapshot: MeterSnapshot; providers: string[] }
          meter.restore(result.snapshot, true)
          setProviders(result.providers)
          setLoaded(true)
          setFailure(undefined)
        } else setFailure("Credential usage could not be retrieved. Retrying automatically.")
        if (selected.sessionID && selected.providerID === "cliproxyapi" && Date.now() - previewAt >= 15_000) {
          previewAt = Date.now()
          const value = await rpc.nextUse({ sessionID: selected.sessionID }, { location: { directory } }).catch(() => undefined)
          if (disposed) return
          const next = parseNextUse(value)
          setPreview(next?.model === selected.modelID ? next : undefined)
          const reading = value as { model?: string; active?: string[]; expires_ms?: number } | undefined
          setActive(reading?.model === selected.modelID && reading.active && reading.expires_ms ? { ids: reading.active, expires: reading.expires_ms } : undefined)
        }
        pending = false
        setClock(Date.now())
      }
      void load()
      const timer = setInterval(() => { setClock(Date.now()); void load() }, options.interval ?? 5000)
      onCleanup(() => { disposed = true; clearInterval(timer) })
    })
    const snapshot = createMemo<UsageSnapshot | undefined>(() => {
      revision()
      const selected = input()
      if (!selected || !loaded()) return
      const value = usageSnapshot(meter, selected, clock(), providers())
      const running = selected.sessionID && context.data.session.status(selected.sessionID) === "running"
      const polled = active()
      value.active = running ? [...new Set([...value.active, ...(polled && polled.expires > clock() ? polled.ids : [])])] : []
      const next = preview()
      if (next && next.expires_ms > clock() && !(next.auth === value.current && value.last_used * 1000 >= next.at_ms)) value.next_use = next
      return value
    })
    return {
      dispose, input, scope, setScope, details, setDetails,
      reading: () => ({ snapshot: snapshot(), failure: failure(), result: failure() ? { message: failure() } : undefined }),
      now: () => clock() / 1000,
      view() { setViews((count) => count + 1); return () => setViews((count) => count - 1) },
    }
  })
}
export type UsageStore = ReturnType<typeof createUsageStore>
