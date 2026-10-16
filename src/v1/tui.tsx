/** @jsxImportSource @opentui/solid */
// opencode-pacer for stock opencode 1.x: the TUI half. A "Usage" section in
// the session sidebar: every account's quota windows with a bar, the % left
// and a countdown to the reset. Readings come from the replies the server half
// saw (shared file) and from Pacer's usage view; neither asks a provider.

import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js"
import fs from "node:fs/promises"
import { discover, normaliseBaseURL, usage, type Connection } from "../core/cpa.js"
import { Meter, bar, windowLine, type CredentialState } from "../core/meter.js"
import { PROVIDER_ID, loadMeter, meterFile } from "./files.js"

const FILE_POLL = 2000
const VIEW_POLL = 60_000
const TICK = 15_000
const SCOPE_KEY = "opencode-pacer.scope"

/** The CPA connection as the TUI sees the provider (key and base URL). */
function connection(api: TuiPluginApi): Connection | undefined {
  const p = api.state.provider.find((item) => item.id === PROVIDER_ID) as unknown as
    | { key?: string; options?: Record<string, unknown> }
    | undefined
  const baseURL = typeof p?.options?.baseURL === "string" ? normaliseBaseURL(p.options.baseURL) : undefined
  const key = typeof p?.key === "string" ? p.key : typeof p?.options?.apiKey === "string" ? (p.options.apiKey as string) : undefined
  return baseURL && key ? { baseURL, key } : undefined
}

function start(api: TuiPluginApi, meter: Meter) {
  let mtime = 0
  const readFile = async () => {
    try {
      const stat = await fs.stat(meterFile())
      if (stat.mtimeMs === mtime) return
      mtime = stat.mtimeMs
      const snapshot = await loadMeter()
      if (snapshot) meter.restore(snapshot)
    } catch {}
  }
  let pacerAt = 0
  let pacer = false
  const readView = async () => {
    const conn = connection(api)
    if (!conn) return
    if (Date.now() - pacerAt > 5 * 60_000) {
      pacerAt = Date.now()
      const answer = await discover(fetch, conn.baseURL)
      // No answer keeps what was known and asks again at the next read.
      if (answer) pacer = answer.pacer
      else pacerAt = 0
    }
    if (!pacer) return
    try {
      meter.applyView(await usage(fetch, conn))
    } catch {}
  }
  void readFile()
  void readView()
  const timers = [setInterval(readFile, FILE_POLL), setInterval(readView, VIEW_POLL)]
  return () => timers.forEach(clearInterval)
}

function Account(props: { api: TuiPluginApi; row: CredentialState; marker?: string; now: number }) {
  const theme = () => props.api.theme.current
  const colour = (s: string) => (s === "error" ? theme().error : s === "warning" ? theme().warning : theme().success)
  return (
    <box>
      <text fg={theme().text} wrapMode="word">
        {props.row.alias}
        <span style={{ fg: theme().textMuted }}> {props.row.provider}</span>
        <Show when={props.marker}>
          <span style={{ fg: theme().primary }}> {props.marker}</span>
        </Show>
      </text>
      <Show when={props.row.shared_with.length > 0}>
        <text fg={theme().textMuted}>shared quota with {props.row.shared_with.join(", ")}</text>
      </Show>
      <For each={props.row.windows.filter((w) => w.applies || props.row.windows.length < 4)}>
        {(w) => {
          const line = () => windowLine(w, props.now)
          return (
            <box flexDirection="row" gap={1}>
              <text fg={theme().textMuted} flexShrink={0}>
                {line().scope ? `${line().label} ${line().scope}` : line().label}
              </text>
              <text fg={colour(line().severity)} flexShrink={0}>
                {bar(line().left, 10)}
              </text>
              <text fg={theme().text} flexShrink={0}>
                {line().left === undefined ? "?" : `${line().left}%`}
              </text>
              <text fg={theme().textMuted}>{line().note ?? line().reset ?? ""}</text>
            </box>
          )
        }}
      </For>
    </box>
  )
}

function View(props: { api: TuiPluginApi; meter: Meter; session_id: string; scope: () => string }) {
  const theme = () => props.api.theme.current
  const [version, setVersion] = createSignal(0)
  const [now, setNow] = createSignal(Date.now())
  onCleanup(props.meter.subscribe(() => setVersion((v) => v + 1)))
  const tick = setInterval(() => setNow(Date.now()), TICK)
  onCleanup(() => clearInterval(tick))
  const served = createMemo(() => (version(), props.meter.lastServed(props.session_id)))
  const rows = createMemo(() => {
    version()
    const last = served()
    const provider = props.scope() !== "all" && last ? props.meter.rows().find((r) => r.id === last.auth)?.provider : undefined
    return props.meter.rows(provider ? { provider } : undefined)
  })
  return (
    <Show when={rows().length > 0}>
      <box>
        <text fg={theme().text}>
          <b>Usage</b>
          <span style={{ fg: theme().textMuted }}>{props.scope() === "all" ? " · all accounts" : ""}</span>
        </text>
        <For each={rows()}>
          {(row) => <Account api={props.api} row={row} now={now()} marker={served()?.auth === row.id ? "LAST USED" : undefined} />}
        </For>
      </box>
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const meter = new Meter()
  const stop = start(api, meter)
  api.lifecycle.onDispose?.(stop)
  const [scope, setScope] = createSignal<string>(api.kv.get(SCOPE_KEY, "model"))
  api.keymap.registerLayer({
    commands: [
      {
        name: "opencode-pacer.usage.scope",
        title: "Usage: switch between this provider and all accounts",
        category: "CLIProxyAPI",
        namespace: "palette",
        slashName: "usage",
        run() {
          const next = scope() === "all" ? "model" : "all"
          setScope(next)
          api.kv.set(SCOPE_KEY, next)
          api.ui.toast({ variant: "info", message: next === "all" ? "Usage shows all accounts" : "Usage shows this chat's provider" })
        },
      },
    ],
  })
  api.slots.register({
    order: 150,
    slots: {
      sidebar_content(_ctx, props) {
        return <View api={api} meter={meter} session_id={props.session_id} scope={scope} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = { id: "opencode-pacer", tui }
export default plugin
