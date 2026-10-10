// Files stock opencode 1.x shares between the plugin's server half (a worker)
// and its TUI half (the main thread): the last model catalogue and the meter.

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { normaliseBaseURL, type Connection } from "../core/cpa.js"
import type { Catalogue } from "../core/models.js"
import type { MeterSnapshot } from "../core/meter.js"

export const PROVIDER_ID = "cliproxyapi"

const xdg = (name: string, fallback: string) => process.env[name] || path.join(os.homedir(), fallback)

/** opencode's data directory (where auth.json lives). */
export function opencodeDataDir(): string {
  return path.join(xdg("XDG_DATA_HOME", ".local/share"), "opencode")
}

/** This plugin's cache directory. */
export function cacheDir(): string {
  return path.join(xdg("XDG_CACHE_HOME", ".cache"), "opencode-pacer")
}

/**
 * The CPA connection /connect stored: `{ type: "api", key, metadata: { baseURL } }`
 * under the provider ID. opencode's config hook has no access to stored
 * credentials, so the plugin reads them where opencode keeps them.
 */
export async function storedConnection(): Promise<Connection | undefined> {
  let all: unknown
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      all = JSON.parse(process.env.OPENCODE_AUTH_CONTENT)
    } catch {}
  }
  if (all === undefined) {
    try {
      all = JSON.parse(await fs.readFile(path.join(opencodeDataDir(), "auth.json"), "utf8"))
    } catch {
      return undefined
    }
  }
  return connectionOf((all as Record<string, unknown>)?.[PROVIDER_ID])
}

export function connectionOf(auth: unknown): Connection | undefined {
  if (!auth || typeof auth !== "object") return undefined
  const a = auth as { type?: unknown; key?: unknown; metadata?: Record<string, unknown> }
  if (a.type !== "api" || typeof a.key !== "string" || !a.key) return undefined
  const baseURL = typeof a.metadata?.baseURL === "string" ? normaliseBaseURL(a.metadata.baseURL) : undefined
  return baseURL ? { baseURL, key: a.key } : undefined
}

async function writeAtomic(file: string, data: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 })
  await fs.rename(tmp, file)
}

async function readJSON<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T
  } catch {
    return undefined
  }
}

const catalogueFile = (baseURL: string) =>
  path.join(cacheDir(), `catalogue-${Buffer.from(baseURL).toString("base64url").slice(0, 80)}.json`)

export interface CachedCatalogue {
  baseURL: string
  at_ms: number
  catalogue: Catalogue
}

export const saveCatalogue = (c: CachedCatalogue) => writeAtomic(catalogueFile(c.baseURL), c)
export const loadCatalogue = (baseURL: string) => readJSON<CachedCatalogue>(catalogueFile(baseURL))

export const meterFile = () => path.join(cacheDir(), "meter.json")
export const saveMeter = (s: MeterSnapshot) => writeAtomic(meterFile(), s)
export const loadMeter = () => readJSON<MeterSnapshot>(meterFile())
