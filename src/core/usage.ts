// OpenCodePlus 1.3.5's usage presentation contract, adapted to Pacer's meter.
import type { Meter } from "./meter.js"
import type { NextUse } from "./protocol.js"

export interface UsageInput {
  sessionID?: string
  providerID: string
  modelID: string
  all: boolean
}
export interface UsageWindow {
  scope: string
  seconds: number
  remaining: number
  reset: number
  observed: number
  state?: string
  updated?: number
  held: boolean
  dormant?: boolean
  not_applicable?: boolean
}
export interface UsageSnapshot {
  protocol: 1
  view: "usage"
  now: number
  max_age_seconds: number
  all: boolean
  provider: string
  providers?: readonly string[]
  model: string
  current: string
  active: readonly string[]
  last_used: number
  next_use?: NextUse
  credentials: readonly {
    id: string
    alias: string
    provider: string
    shared_with: readonly string[]
    windows: readonly UsageWindow[]
  }[]
}

export function usageSnapshot(meter: Meter, input: UsageInput, now: number, providers: readonly string[]): UsageSnapshot {
  const served = input.sessionID ? meter.lastServed(input.sessionID) : undefined
  const rows = meter.rows()
  const current = rows.find((row) => row.id === served?.auth && providers.includes(row.provider))
  const activity = input.sessionID ? meter.snapshot().activity?.[input.sessionID]?.auth : undefined
  return {
    protocol: 1, view: "usage", now: now / 1000, max_age_seconds: 90,
    all: input.all, provider: providers[0] ?? "", providers, model: input.modelID,
    current: current?.id ?? "", active: activity && rows.some((row) => row.id === activity && providers.includes(row.provider)) ? [activity] : [],
    last_used: (served?.at_ms ?? 0) / 1000,
    credentials: rows.filter((row) => input.all || providers.includes(row.provider)).map((row) => ({
      id: row.id, alias: row.alias, provider: row.provider, shared_with: row.shared_with,
      windows: row.windows.filter((w) => w.left !== undefined && (w.reset_ms !== undefined || w.state === "dormant")).map((w) => ({
        scope: w.scope, seconds: w.seconds, remaining: w.left!, reset: (w.reset_ms ?? 0) / 1000,
        state: w.state, updated: row.at_ms / 1000, observed: (w.read_ms ?? row.at_ms) / 1000,
        held: false, dormant: w.state === "dormant", not_applicable: !w.applies,
      })),
    })),
  }
}
