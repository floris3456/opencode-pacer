// opencode-pacer for stock opencode 1.x: the server half.
//
// - /connect lists "CLIProxyAPI" and asks for its URL and API key.
// - Models come from CPA's catalogue, with Pacer's prices when Pacer runs.
// - Each model request declares the client to Pacer; the quota on each reply
//   goes to the meter the TUI half shows in the sidebar.
// stock 1.x has no hook to compact before an account switch, so this client
// never asks for that: Pacer simply switches its chats.

import type { Hooks, Plugin, PluginModule } from "@opencode-ai/plugin"
import { discover, models, normaliseBaseURL, originOf, prices, type Connection } from "../core/cpa.js"
import { pacerFetch } from "../core/fetch.js"
import { Meter } from "../core/meter.js"
import { parseCatalogue, withPrices, type Catalogue } from "../core/models.js"
import type { Discovery } from "../core/protocol.js"
import { PROVIDER_ID, connectionOf, loadCatalogue, loadMeter, saveCatalogue, saveMeter, storedConnection } from "./files.js"
import { providerEntry } from "./provider.js"

const STARTUP_TIMEOUT = 4000
const DISCOVERY_TTL = 5 * 60_000

/** Fetches the catalogue (and prices when Pacer runs); falls back to the last one. */
export async function catalogueFor(conn: Connection, fetchFn: typeof fetch = fetch): Promise<Catalogue | undefined> {
  try {
    const [list, discovery] = await Promise.all([models(fetchFn, conn, STARTUP_TIMEOUT), discover(fetchFn, conn.baseURL, STARTUP_TIMEOUT)])
    let catalogue = parseCatalogue(list)
    if (discovery.pacer && discovery.views.includes("prices")) {
      try {
        catalogue = withPrices(catalogue, await prices(fetchFn, conn, STARTUP_TIMEOUT))
      } catch {}
    }
    await saveCatalogue({ baseURL: conn.baseURL, at_ms: Date.now(), catalogue }).catch(() => {})
    return catalogue
  } catch {
    return (await loadCatalogue(conn.baseURL))?.catalogue
  }
}

export const server: Plugin = async (_input, options) => {
  const fetchFn: typeof fetch = (options?.fetch as typeof fetch | undefined) ?? fetch
  const meter = new Meter()
  const previous = await loadMeter()
  if (previous) meter.restore(previous)
  // The TUI half reads the meter from a file: write it at once after each
  // reply, one write at a time.
  let writing: Promise<void> | undefined
  let dirty = false
  const persist = () => {
    dirty = true
    if (writing) return
    writing = (async () => {
      while (dirty) {
        dirty = false
        await saveMeter(meter.snapshot()).catch(() => {})
      }
      writing = undefined
    })()
  }
  meter.subscribe(persist)

  let discovery: { at: number; value: Discovery; origin: string } | undefined
  const refreshDiscovery = (baseURL: string) => {
    const origin = originOf(baseURL)
    if (discovery && discovery.origin === origin && Date.now() - discovery.at < DISCOVERY_TTL) return
    const at = Date.now()
    discovery = { at, origin, value: discovery?.origin === origin ? discovery.value : { pacer: false, views: [] } }
    void discover(fetchFn, baseURL).then((value) => {
      if (discovery?.at === at) discovery = { at, origin, value }
    })
  }

  const hooks: Hooks = {
    config: async (cfg) => {
      const conn = await storedConnection()
      const catalogue = conn ? await catalogueFor(conn, fetchFn) : undefined
      const providers = ((cfg as Record<string, unknown>).provider ??= {}) as Record<string, Record<string, unknown>>
      providers[PROVIDER_ID] = providerEntry(catalogue, conn?.baseURL, providers[PROVIDER_ID])
    },
    auth: {
      provider: PROVIDER_ID,
      methods: [
        {
          type: "api",
          label: "CLIProxyAPI URL and API key",
          prompts: [
            {
              type: "text",
              key: "baseURL",
              message: "CLIProxyAPI URL",
              placeholder: "https://cpa.example.com/v1",
              validate: (value) => (normaliseBaseURL(value) ? undefined : "Enter an http(s) URL, such as https://cpa.example.com/v1"),
            },
          ],
        },
      ],
      loader: async (getAuth) => {
        const conn = connectionOf(await getAuth())
        if (!conn) return {}
        refreshDiscovery(conn.baseURL)
        return {
          baseURL: conn.baseURL,
          apiKey: conn.key,
          fetch: pacerFetch({
            origin: originOf(conn.baseURL),
            pacer: () => {
              refreshDiscovery(conn.baseURL)
              return discovery?.value.pacer === true
            },
            onQuota: (reply, session) => meter.applyReply(reply, session),
            base: fetchFn,
          }),
        }
      },
    },
    dispose: async () => {
      await writing
    },
  }
  return hooks
}

const plugin: PluginModule & { id: string } = { id: "opencode-pacer", server }
export default plugin
