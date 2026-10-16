// opencode-pacer for stock opencode 2.x: the server half.
//
// - /connect lists CLIProxyAPI: one URL + API key; the URL is the form answer
//   `configuration.baseURL` of the integration credential.
// - The model catalogue comes from CPA (`/models?details=true`), with Pacer's
//   prices when Pacer runs (view=prices). Claude models go through CPA's
//   Anthropic Messages relay.
// - Every model request declares the client to Pacer (`X-Pacer-Client: v=1;
//   caps=quota`); the quota on each reply (`X-Pacer-Quota`) and Pacer's shared
//   usage view feed the meter the CLI half renders in the sidebar (over RPC:
//   the `snapshot` method plus `meter` events).
// - Account switches (core/switch.ts): the chat's own Claude requests claim
//   `compact_on_switch`, so CPA does not move a chat to another account with
//   its whole history. It refuses that one request; the plugin answers it as
//   "too long", which makes OpenCode summarise the chat and rerun the step,
//   and points OpenCode's summary agent at a cheap model (`compactionModel`,
//   default Claude Haiku) until that rerun.

import { Model, Plugin } from "@opencode/plugin"
import type { Context } from "@opencode/plugin/promise/plugin"
import type { ProviderEditor } from "@opencode/plugin/promise/provider"
import type { SessionHttpRequest, SessionHttpResponse, SessionModelRequest } from "@opencode/plugin/promise/session"
import {
  chatUsage,
  discover,
  models as fetchModels,
  normaliseBaseURL,
  originOf,
  prices as fetchPrices,
  watchUsage,
  type Connection,
} from "../core/cpa.js"
import { Meter } from "../core/meter.js"
import { parseCatalogue, withPrices, type Catalogue } from "../core/models.js"
import { CLIENT_HEADER, QUOTA_HEADER, declaration, decodeQuota, type Discovery } from "../core/protocol.js"
import {
  CLAIM_HEADER,
  claim,
  compactRefusal,
  newBinding,
  newInstallation,
  parseBinding,
  refusedAgainReply,
  summaryFirstReply,
  type Binding,
} from "../core/switch.js"
import { PacerRpc } from "../rpc.js"
import { applyCatalogueModel, DEFAULT_PACKAGE, type ProviderModelsEditor } from "./models.js"

export const PROVIDER_ID = "cliproxyapi"
export const INTEGRATION_ID = "cliproxyapi"

/** HTTPS anywhere, or HTTP only to a loopback host, then an optional path, ending in `/v1`. */
export const BASE_URL_PATTERN = String.raw`^(https://[^/\s]+|http://(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?)(/[^/\s]+)*/v1$`

const CATALOGUE_REFRESH_MS = 5 * 60_000
const CATALOGUE_RETRY_MS = 15_000
const DISCOVERY_TTL_MS = 5 * 60_000
const TIMEOUT_MS = 8_000
const PERSIST_MS = 5_000
/** A switch whose run never ended (no execution event) gives the summary model back after this. */
const SWITCH_TIMEOUT_MS = 10 * 60_000
/** Request kinds that carry the chat's claim: its own steps and its warming pings. */
const CLAIMED_KINDS = new Set(["primary", "generate"])

interface Route {
  /** The CPA base URL, ending in /v1. */
  baseURL: string
  origin: string
  key: string
}

interface State {
  route?: Route
  pacer: boolean
  views: string[]
  discoveryAt: number
  catalogue?: Catalogue
  catalogueText?: string
}

const unref = (timer: { unref?: () => void } | number | undefined) =>
  (timer as { unref?: () => void } | undefined)?.unref?.()

const originOfURL = (url: string | undefined): string | undefined => {
  try {
    return url ? new URL(url).origin : undefined
  } catch {
    return undefined
  }
}

export async function setup(ctx: Context) {
  console.error(`opencode-pacer v2 loaded in OpenCode ${ctx.app.version}`)
  const meter = new Meter()
  const state: State = { pacer: false, views: [], discoveryAt: 0 }
  const recordedRoutes = new Map<string, string>()

  const stored = await ctx.storage.get("meter").catch(() => undefined)
  if (stored) meter.restore(stored as never)
  // The last good catalogue per base URL, with what discovery said about Pacer:
  // models are listed, and chat requests claimed, from the first read after a
  // restart and through CPA outages, not after the first fetch.
  const saved = (await ctx.storage.get("catalogue").catch(() => undefined)) as
    | { baseURL?: string; catalogue?: Catalogue; pacer?: boolean; views?: string[] }
    | undefined
  let savedText = saved ? JSON.stringify(saved) : undefined

  // Meter → RPC events plus throttled persistence. RPC output and storage
  // reject `undefined` members (absent reset times etc.), so send plain JSON.
  const plain = () => JSON.parse(JSON.stringify(meter.snapshot())) as Record<string, unknown>
  const registration = await ctx.rpc.register(PacerRpc, {
    snapshot: async () => plain() as never,
    usage: async (input) => {
      const selected = input as { providerID: string; modelID: string }
      const providers = selected.providerID === PROVIDER_ID
        ? state.catalogue?.models.find((model) => model.id === selected.modelID)?.providers ?? []
        : []
      return { snapshot: plain(), providers }
    },
    nextUse: async (input) => {
      const sessionID = (input as { sessionID: string }).sessionID
      const route = state.route
      if (!route || !state.pacer) return {}
      const session = await ctx.session.get({ sessionID })
      const last = await ctx.storage.get(`session-route/${sessionID}`) as { providerID: string; id: string; baseURL: string } | undefined
      const model = session.model ?? last
      if (!model || model.providerID !== PROVIDER_ID || !last || last.baseURL !== route.baseURL) return {}
      const routeID = `${model.providerID}/${model.id}`
      const stored = await ctx.storage.get(`binding/${sessionID}/${routeID}`) as Binding | undefined
      if (!stored?.capability) return {}
      const view = await chatUsage(fetch, route.baseURL, stored.capability, routeID, TIMEOUT_MS)
      meter.applyView(view)
      return JSON.parse(JSON.stringify({ model: model.id, expires_ms: Date.now() + 30_000, ...view.next_use, active: view.active ?? [] }))
    },
  })
  const emit = (snapshot: Record<string, unknown>) => {
    void registration.events.emit("meter", { snapshot } as never).catch(() => {})
  }
  let persistedAt = 0
  const persist = (snapshot: Record<string, unknown>) => {
    const now = Date.now()
    if (now - persistedAt < PERSIST_MS) return
    persistedAt = now
    void ctx.storage.set("meter", snapshot as never).catch(() => {})
  }
  meter.subscribe(() => {
    const snapshot = plain()
    emit(snapshot)
    persist(snapshot)
  })

  // ---- /connect: the CLIProxyAPI integration.
  await ctx.integration.transform((editor) => {
    editor.update(INTEGRATION_ID, (integration) => {
      integration.name = "CLIProxyAPI"
    })
    editor.method.update({
      integrationID: INTEGRATION_ID,
      method: {
        type: "key",
        label: "CLIProxyAPI API key",
        form: [
          {
            type: "string",
            key: "baseURL",
            title: "CLIProxyAPI URL",
            description: "The URL must end in /v1 and use HTTPS (plain HTTP is allowed only for localhost).",
            placeholder: "https://cpa.example.com/v1",
            required: true,
            pattern: BASE_URL_PATTERN,
          },
        ],
      },
    } as never)
  })

  // ---- provider + models: the provider is always registered (core activates
  // it while the integration has a connection); models replay from state.
  const applyProvider = (editor: ProviderEditor) => {
    editor.update(PROVIDER_ID, (provider) => {
      provider.name = "CLIProxyAPI"
      if (!provider.package) provider.package = DEFAULT_PACKAGE
    })
    const catalogue = state.catalogue
    if (!catalogue || !state.route) return
    const pkg = editor.get(PROVIDER_ID)?.provider.package ?? DEFAULT_PACKAGE
    const wanted = new Set<string>()
    for (const item of catalogue.models) {
      if (item.kind !== "chat") continue
      wanted.add(item.id)
      applyCatalogueModel(editor as unknown as ProviderModelsEditor, PROVIDER_ID, item, pkg)
    }
    // Models that left the catalogue go away.
    const record = editor.get(PROVIDER_ID)
    if (record) for (const id of record.models.keys()) if (!wanted.has(id)) editor.models.remove(PROVIDER_ID, id)
  }
  await ctx.provider.transform(applyProvider)

  // ---- account switches: claims, the refused-request handling and the
  // summary model used while CPA waits for a summary.
  const options = ctx.options as { accountSwitch?: unknown; compactionModel?: unknown }
  const switching = options.accountSwitch !== false
  const installation =
    ((await ctx.storage.get("installation").catch(() => undefined)) as string | undefined) ?? newInstallation()
  await ctx.storage.set("installation", installation).catch(() => {})
  const bindings = new Map<string, Promise<Binding>>()
  const bindingFor = (session: string, route: string) => {
    const key = `binding/${session}/${route}`
    const known = bindings.get(key)
    if (known) return known
    const loading = (async () => {
      const stored = (await ctx.storage.get(key).catch(() => undefined)) as Binding | undefined
      if (typeof stored?.capability === "string" && typeof stored.generation === "number") return { ...stored }
      const created = newBinding()
      await ctx.storage.set(key, { ...created }).catch(() => {})
      return created
    })()
    bindings.set(key, loading)
    return loading
  }
  /** Claimed requests in flight, by the Request object OpenCode sends and hands back with the reply. */
  const claims = new WeakMap<Request, { session: string; route: string; kind: string; checkpoint: string }>()

  /** Chats CPA is moving: the checkpoint the refused request carried, and the summary model in use. */
  const switches = new Map<string, { checkpoint: string; model?: string; timer: ReturnType<typeof setTimeout> }>()
  /** The first model Pacer names that CPA lists, else `compactionModel`, else Claude Haiku. */
  const summaryModel = (named: readonly string[] = []) => {
    const chat = (id: string) => state.catalogue?.models.some((model) => model.kind === "chat" && model.id === id)
    const pacer = named.find(chat)
    const configured = typeof options.compactionModel === "string" ? options.compactionModel.trim() : ""
    const haiku = state.catalogue?.models.find((model) => model.kind === "chat" && model.id.startsWith("claude-haiku"))
    const ref = pacer ? `${PROVIDER_ID}/${pacer}` : configured || (haiku ? `${PROVIDER_ID}/${haiku.id}` : "")
    if (!ref) return undefined
    try {
      Model.Ref.parse(ref)
    } catch {
      return undefined
    }
    return ref
  }
  const endSwitch = async (session: string) => {
    const ended = switches.get(session)
    if (!ended) return
    clearTimeout(ended.timer)
    switches.delete(session)
    if (ended.model) await ctx.agent.reload()
  }
  // While a chat waits for its switch summary, OpenCode's summary agent uses
  // the cheap model; otherwise the user's own setting applies.
  await ctx.agent.transform((editor) => {
    const model = [...switches.values()].find((entry) => entry.model)?.model
    if (!model || !editor.get("compaction")) return
    editor.update("compaction", (agent) => {
      agent.model = Model.Ref.parse(model)
    })
  })

  // ---- session hooks: declare the client, claim the chat, capture the quota.
  await ctx.session.hook(
    "model.request",
    (event: SessionModelRequest) => {
      const route = state.route
      const same = route !== undefined && (event.baseURL === undefined || originOfURL(event.baseURL) === route.origin)
      if (same && state.pacer) event.headers[CLIENT_HEADER] = declaration({ quota: true })!
      else delete event.headers[CLIENT_HEADER]
    },
    { providerID: PROVIDER_ID },
  )
  await ctx.session.hook(
    "http.request",
    async (event: SessionHttpRequest) => {
      const route = state.route
      if (!switching || !route || !state.pacer || !CLAIMED_KINDS.has(event.kind)) return
      const url = new URL(event.request.url)
      // Only CPA's Anthropic Messages relay: Pacer coordinates Claude accounts.
      if (event.request.method !== "POST" || url.origin !== route.origin) return
      if (url.pathname !== `${new URL(route.baseURL).pathname}/messages`) return
      // The chat's newest durable summary, never a marker from message text.
      const messages = await ctx.session.context({ sessionID: event.sessionID }, { signal: event.request.signal })
      const checkpoint = messages.findLast((m) => m.type === "compaction" && m.status === "completed")?.id ?? ""
      const pending = switches.get(event.sessionID)
      if (pending?.model && event.kind === "primary" && checkpoint !== pending.checkpoint) {
        // The switch summary exists and this is the rerun: summaries use the user's model again.
        pending.model = undefined
        await ctx.agent.reload()
      }
      const routeID = `${event.model.providerID}/${event.model.id}`
      const binding = await bindingFor(event.sessionID, routeID)
      if (event.kind === "primary" && recordedRoutes.get(event.sessionID) !== `${route.baseURL}/${routeID}`) {
        await ctx.storage.set(`session-route/${event.sessionID}`, { providerID: event.model.providerID, id: event.model.id, baseURL: route.baseURL })
        recordedRoutes.set(event.sessionID, `${route.baseURL}/${routeID}`)
      }
      const headers = new Headers(event.request.headers)
      headers.set(
        CLAIM_HEADER,
        claim({ installation, session: event.sessionID, route: routeID, kind: event.kind, binding, checkpoint }),
      )
      event.request = new Request(event.request, { headers })
      claims.set(event.request, { session: event.sessionID, route: routeID, kind: event.kind, checkpoint })
    },
    { providerID: PROVIDER_ID },
  )
  await ctx.session.hook(
    "http.response",
    async (event: SessionHttpResponse) => {
      const route = state.route
      if (!route || originOfURL(event.request.url) !== route.origin) return
      const reply = decodeQuota(event.response.headers.get(QUOTA_HEADER))
      if (reply) meter.applyReply(reply, event.kind === "primary" ? event.sessionID : undefined, event.kind === "primary")

      const claimed = claims.get(event.request)
      if (!claimed) return
      claims.delete(event.request)
      const refusal = await compactRefusal(event.response)
      if (refusal) {
        // A refused warming ping just fails: it must not carry the whole chat to another account.
        if (claimed.kind !== "primary") return
        if (switches.has(claimed.session)) {
          // Refused again after the summary: stop rather than summarise in a loop.
          await endSwitch(claimed.session)
          event.response = refusedAgainReply()
          return
        }
        const model = summaryModel(refusal.models)
        const timer = setTimeout(() => void endSwitch(claimed.session).catch(console.error), SWITCH_TIMEOUT_MS)
        unref(timer)
        switches.set(claimed.session, { checkpoint: claimed.checkpoint, model, timer })
        if (model) await ctx.agent.reload()
        event.response = summaryFirstReply()
        return
      }
      const binding = parseBinding(event.response.headers)
      if (!binding) return
      const known = await bindingFor(claimed.session, claimed.route)
      if (known.generation !== binding.generation) {
        known.generation = binding.generation
        await ctx.storage.set(`binding/${claimed.session}/${claimed.route}`, { ...known }).catch(() => {})
      }
      // CPA admitted the chat's step: a switch in progress is complete.
      if (claimed.kind === "primary") await endSwitch(claimed.session)
    },
    { providerID: PROVIDER_ID },
  )

  // ---- the connection route: resolved from the active credential's form.
  const resolveRoute = async () => {
    const active = await ctx.integration.connection.active(INTEGRATION_ID).catch(() => undefined)
    if (!active || (active as { type?: string }).type !== "credential") {
      state.route = undefined
      return
    }
    const credential = await ctx.integration.connection.resolve(active).catch(() => undefined)
    const value = credential as { type?: string; key?: string; configuration?: Record<string, unknown> } | undefined
    const raw = value?.type === "key" ? value.configuration?.baseURL : undefined
    const baseURL = typeof raw === "string" ? normaliseBaseURL(raw) : undefined
    if (value?.type === "key" && typeof value.key === "string" && value.key && baseURL) {
      state.route = { baseURL, origin: originOf(baseURL), key: value.key }
    } else {
      state.route = undefined
    }
  }

  await resolveRoute()
  const restored = !!state.route && !!saved?.catalogue && saved.baseURL === state.route.baseURL
  if (restored) {
    state.catalogue = saved.catalogue
    state.catalogueText = JSON.stringify(saved.catalogue)
    state.pacer = saved.pacer === true
    state.views = Array.isArray(saved.views) ? saved.views : []
    await ctx.provider.reload()
  }

  /** Returns whether CPA answered every read; a failed one keeps the last catalogue and discovery, and
   * the loop asks again at the quick retry. */
  const refresh = async (): Promise<boolean> => {
    await resolveRoute()
    const route = state.route
    if (!route) {
      state.pacer = false
      syncUsage()
      if (state.catalogue) {
        state.catalogue = undefined
        state.catalogueText = undefined
        await ctx.provider.reload()
      }
      return true
    }
    const due = Date.now() - state.discoveryAt > DISCOVERY_TTL_MS
    // A CPA that was not reached is not a CPA without Pacer: without an answer the chats stay claimed.
    const answer = due ? await discover(fetch, route.baseURL, TIMEOUT_MS) : undefined
    if (answer) state.discoveryAt = Date.now()
    const discovery: Discovery = answer ?? { pacer: state.pacer, views: state.views }
    state.pacer = discovery.pacer
    state.views = discovery.views
    syncUsage()
    let catalogue: Catalogue
    try {
      catalogue = parseCatalogue(await fetchModels(fetch, route as Connection, TIMEOUT_MS))
      if (discovery.pacer && discovery.views.includes("prices")) {
        const pricing = await fetchPrices(fetch, route as Connection, TIMEOUT_MS).catch(() => undefined)
        catalogue = withPrices(catalogue, pricing)
      }
    } catch {
      return false
    }
    const text = JSON.stringify(catalogue)
    if (text !== state.catalogueText) {
      state.catalogue = catalogue
      state.catalogueText = text
      await ctx.provider.reload()
    }
    const record = JSON.stringify({ baseURL: route.baseURL, catalogue, pacer: state.pacer, views: state.views })
    if (record !== savedText) {
      savedText = record
      await ctx.storage.set("catalogue", JSON.parse(record)).catch(() => {})
    }
    return !due || answer !== undefined
  }

  /** Set by the returned cleanup: work still running then starts no loop. */
  let disposed = false
  let usageFeed: { baseURL: string; key: string; controller: AbortController } | undefined
  const syncUsage = () => {
    if (disposed) return
    const route = state.route
    if (route && state.pacer && usageFeed?.baseURL === route.baseURL && usageFeed.key === route.key) return
    usageFeed?.controller.abort()
    usageFeed = undefined
    if (route && state.pacer) {
      const controller = new AbortController()
      usageFeed = { baseURL: route.baseURL, key: route.key, controller }
      void watchUsage(fetch, route, (view) => meter.applyView(view), controller.signal)
    }
  }

  // ---- loops: catalogue quickly until every route answers, then every five
  // minutes; shared usage is delivered by Pacer's change subscription.
  let catalogueTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleCatalogue = (delay: number) => {
    if (disposed) return
    catalogueTimer = setTimeout(async () => {
      const reached = await refresh().catch(() => false)
      scheduleCatalogue(reached ? CATALOGUE_REFRESH_MS : CATALOGUE_RETRY_MS)
    }, delay)
    unref(catalogueTimer)
  }
  // Nothing saved for this connection yet (first start after /connect): wait
  // for one fetch, so the first prompt does not find the models missing.
  if (state.route && !restored)
    scheduleCatalogue((await refresh().catch(() => false)) ? CATALOGUE_REFRESH_MS : CATALOGUE_RETRY_MS)
  else scheduleCatalogue(0)
  syncUsage()

  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        const type = (event as { type?: string }).type
        // A run that ended without CPA admitting the chat (summary failed, cancelled, refused again).
        if (type === "session.execution.succeeded" || type === "session.execution.failed" || type === "session.execution.interrupted") {
          const session = (event as { data?: { sessionID?: unknown } }).data?.sessionID
          if (typeof session === "string") {
            meter.endActivity(session)
            await endSwitch(session)
          }
          continue
        }
        if (type !== "credential.switched") continue
        await refresh().catch(() => {})
        syncUsage()
      }
    } catch {
      // The subscription ends with the plugin; nothing to report.
    }
  })()

  return () => {
    disposed = true
    controller.abort()
    if (catalogueTimer) clearTimeout(catalogueTimer)
    usageFeed?.controller.abort()
    for (const entry of switches.values()) clearTimeout(entry.timer)
  }
}

export default Plugin.define({ id: "opencode-pacer", setup })
