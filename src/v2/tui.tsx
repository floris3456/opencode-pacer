/** @jsxImportSource @opentui/solid */
// opencode-pacer for stock opencode 2.x: the CLI half. A "Usage" section in
// the session sidebar: every account's quota windows with a bar, the % left and
// a countdown to the reset. The server half records readings (quota replies and
// Pacer's usage view) and publishes them over the Pacer RPC; this half renders
// the snapshot and subscribes to updates. Neither half asks a provider.

import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js"
import { parseNextUse, type NextUse } from "../core/protocol.js"
import { Meter, bar, windowLine, type CredentialState, type MeterSnapshot } from "../core/meter.js"
import { PacerRpc, type PacerMeterEvent } from "../rpc.js"

const PROBE_MS = 2_000
const PROBE_ATTEMPTS = 15
const SNAPSHOT_MS = 60_000
const TICK_MS = 15_000
const SLASH = "usage"

const unref = (timer: ReturnType<typeof setTimeout>) => (timer as { unref?: () => void }).unref?.()

function View(props: {
  context: Context
  snapshot: () => MeterSnapshot | undefined
  mode: () => "model" | "all"
  sessionID: string
}) {
  const theme = props.context.theme
  const [now, setNow] = createSignal(Date.now())
  const timer = setInterval(() => setNow(Date.now()), TICK_MS)
  onCleanup(() => clearInterval(timer))
  const served = createMemo(() => props.snapshot()?.served?.[props.sessionID])
  const [preview, setPreview] = createSignal<NextUse>()
  const [active, setActive] = createSignal<{ ids: string[]; expires: number }>()
  const rpc = props.context.client.rpc(PacerRpc)
  createEffect(() => {
    const sessionID = props.sessionID
    const session = props.context.data.session.get(sessionID)
    const model = session?.model
    const directory = session?.location.directory ?? props.context.location?.directory ?? props.context.data.location.default().directory
    // Changing chat/model/location retires an outstanding result immediately.
    const selected = model ? `${model.providerID}/${model.id}` : ""
    props.context.data.session.status(sessionID)
    setPreview(undefined)
    setActive(undefined)
    let disposed = false
    let loading = false
    const load = async () => {
      if (loading) return
      loading = true
      const value = await rpc.nextUse({ sessionID }, { location: { directory } }).catch(() => undefined)
      loading = false
      if (disposed) return
      const next = parseNextUse(value)
      setPreview(next && (!selected || selected.endsWith(`/${next.model}`)) ? next : undefined)
      const activity = value as { active?: unknown; expires_ms?: unknown } | undefined
      setActive(Array.isArray(activity?.active) && typeof activity?.expires_ms === "number"
        ? { ids: activity.active.filter((id): id is string => typeof id === "string"), expires: activity.expires_ms }
        : undefined)
      setNow(Date.now())
    }
    void load()
    const poll = setInterval(() => void load(), TICK_MS)
    onCleanup(() => { disposed = true; clearInterval(poll) })
  })
  const nextUse = () => {
    const value = preview()
    const last = served()
    if (value && last && value.auth === last.auth && last.at_ms >= value.at_ms) return undefined
    return value && value.expires_ms > now() ? value : undefined
  }
  const inUse = (id: string) =>
    props.context.data.session.status(props.sessionID) === "running" &&
    (props.snapshot()?.activity?.[props.sessionID]?.auth === id ||
      ((active()?.expires ?? 0) > now() && active()?.ids.includes(id)))
  const rows = createMemo<CredentialState[]>(() => {
    const snapshot = props.snapshot()
    if (!snapshot) return []
    const last = served()
    const provider =
      props.mode() === "all" || !last ? undefined : snapshot.credentials.find((row) => row.id === last.auth)?.provider
    return snapshot.credentials
      .filter((row) => (provider ? row.provider === provider : true))
      .sort((a, b) => a.provider.localeCompare(b.provider) || a.alias.localeCompare(b.alias))
  })
  const colour = (severity: string) =>
    severity === "error"
      ? theme.text.feedback.error.base
      : severity === "warning"
        ? theme.text.feedback.warning.base
        : theme.text.feedback.success.base
  return (
    <Show when={rows().length > 0}>
      <box>
        <text fg={theme.text.base}>
          Usage
          <span style={{ fg: theme.text.muted }}>{props.mode() === "all" ? " · all accounts" : ""}</span>
        </text>
        <For each={rows()}>
          {(row) => (
            <box>
              <text fg={theme.text.base} wrapMode="word">
                {row.alias}
                <span style={{ fg: theme.text.muted }}> {row.provider}</span>
              </text>
              <Show when={served()?.auth === row.id && !inUse(row.id)}>
                <text fg={theme.text.feedback.info.base}>LAST USED</text>
              </Show>
              <Show when={inUse(row.id)}>
                <text fg={theme.text.feedback.success.base}>IN USE</text>
              </Show>
              <Show when={nextUse()?.auth === row.id && nextUse()?.provider === row.provider}>
                <text fg={theme.text.feedback.info.base}>NEXT USE{nextUse()?.mode === "dry-run" ? " · dry-run" : ""}</text>
                <text fg={theme.text.muted}>{nextUse()?.forced ? "quota switch" : "cold-cache preference"}</text>
              </Show>
              <Show when={row.shared_with.length > 0}>
                <text fg={theme.text.muted}>shared quota with {row.shared_with.join(", ")}</text>
              </Show>
              <For each={row.windows.filter((window) => window.applies || row.windows.length < 4)}>
                {(window) => {
                  const line = () => windowLine(window, now())
                  return (
                    <box flexDirection="row" gap={1}>
                      <text fg={theme.text.muted} flexShrink={0}>
                        {line().scope ? `${line().label} ${line().scope}` : line().label}
                      </text>
                      <text fg={colour(line().severity)} flexShrink={0}>
                        {bar(line().left, 10)}
                      </text>
                      <text fg={theme.text.base} flexShrink={0}>
                        {line().left === undefined ? "?" : `${line().left}%`}
                      </text>
                      <text fg={theme.text.muted}>{line().note ?? line().reset ?? ""}</text>
                    </box>
                  )
                }}
              </For>
            </box>
          )}
        </For>
      </box>
    </Show>
  )
}

export function setup(context: Context) {
  const rpc = context.client.rpc(PacerRpc)
  const [snapshot, setSnapshot] = createSignal<MeterSnapshot>()
  const [settings, update] = context.storage.store("scope", { initial: { mode: "model" as "model" | "all" } })
  const state = { disposed: false }

  // Every project location runs its own server half, each with its own meter,
  // and all of them publish here. Merge them (newest reading per account and
  // per chat wins) rather than letting the last publisher replace the view.
  const meter = new Meter()
  meter.subscribe(() => setSnapshot(meter.snapshot()))
  const apply = (value: unknown) => {
    if (value && typeof value === "object") meter.restore(value as MeterSnapshot, true)
  }
  const off = rpc.events.on("meter", (event) =>
    apply((event.data as unknown as PacerMeterEvent | undefined)?.snapshot),
  )

  // Ask the server half of this CLI's own location: that one recorded which
  // account served the chats started here, so the first view is already scoped.
  const directory = (context.location ?? context.data.location.default()).directory
  const load = async (attempt: number): Promise<void> => {
    if (state.disposed) return
    const result = await rpc.snapshot({}, { location: { directory } }).catch(() => undefined)
    if (state.disposed) return
    if (result === undefined) {
      if (attempt < PROBE_ATTEMPTS) unref(setTimeout(() => void load(attempt + 1), PROBE_MS))
      return
    }
    apply(result)
  }
  void load(0)
  const poll = setInterval(() => void load(PROBE_ATTEMPTS), SNAPSHOT_MS)
  unref(poll)

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "opencode-pacer.usage.scope",
        title: "Usage: switch between this provider and all accounts",
        group: "CLIProxyAPI",
        slash: { name: SLASH },
        run() {
          const next = settings.mode === "all" ? "model" : "all"
          void update((draft) => {
            draft.mode = next
          })
          context.ui.toast.show({
            variant: "info",
            message: next === "all" ? "Usage shows all accounts" : "Usage shows this chat's provider",
          })
        },
      },
    ],
  }))

  const release = context.ui.slot({
    append: "sidebar.content",
    render: (input) => (
      <View context={context} snapshot={snapshot} mode={() => settings.mode} sessionID={input.sessionID} />
    ),
  })

  return () => {
    state.disposed = true
    off()
    clearInterval(poll)
    release()
  }
}

export default Plugin.define({ id: "opencode-pacer", setup })
