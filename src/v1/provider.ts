// The `cliproxyapi` provider for stock opencode 1.x, built from CPA's
// catalogue and Pacer's prices. Pure: the server plugin applies it in its
// config hook.

import { EFFORTS, costOf, isClaude, type CatalogModel, type Catalogue } from "../core/models.js"

export const PLACEHOLDER_MODEL = "connect-cliproxyapi"

type Json = Record<string, unknown>

/** One opencode 1.x model entry (config schema `provider.<id>.models.<id>`). */
export function modelEntry(m: CatalogModel, baseURL: string | undefined): Json {
  const entry: Json = {
    id: m.id,
    name: m.name,
    tool_call: true,
    reasoning: m.reasoning.mode !== "none",
    attachment: m.input.some((x) => x !== "text"),
    modalities: { input: [...m.input], output: [...m.outputModalities] },
  }
  if (m.context && m.output) entry.limit = { context: m.context, output: m.output, ...(m.inputLimit ? { input: m.inputLimit } : {}) }
  const cost = costOf(m.price)
  if (cost) {
    const over = m.price?.context_tiers?.find((t) => t.above_tokens === 200_000)
    entry.cost = over ? { ...cost, context_over_200k: costOf({ ...over.price, source: "" }) } : cost
  }
  const claude = isClaude(m) && !!baseURL
  if (claude) {
    // CPA's Anthropic Messages relay (<base>/messages): prompt caching and
    // thinking as Claude defines them.
    entry.provider = { npm: "@ai-sdk/anthropic", api: baseURL }
  }
  if (m.reasoning.mode === "levels" && m.reasoning.levels.length) {
    // Exactly the effort levels CPA accepts for this model. opencode spells
    // Claude's thinking itself; levels CPA refuses are switched off.
    const variants: Record<string, Json> = {}
    for (const effort of EFFORTS) {
      if (!m.reasoning.levels.includes(effort)) variants[effort] = { disabled: true }
      else if (!claude) variants[effort] = { reasoningEffort: effort }
    }
    entry.variants = variants
  }
  return entry
}

/**
 * The provider, merged over what the user wrote: their provider options and
 * per-model settings win. Without a catalogue a single placeholder model keeps
 * the provider listed in /connect.
 */
export function providerEntry(catalogue: Catalogue | undefined, baseURL: string | undefined, existing: Json | undefined): Json {
  const user = existing ?? {}
  const userModels = (user.models ?? {}) as Record<string, Json>
  const models: Record<string, Json> = {}
  for (const m of catalogue?.models ?? []) {
    // Image models answer only on CPA's images endpoint, never in chat.
    if (m.kind !== "chat") continue
    models[m.id] = { ...modelEntry(m, baseURL), ...(userModels[m.id] ?? {}) }
  }
  for (const [id, model] of Object.entries(userModels)) models[id] ??= model
  if (Object.keys(models).length === 0)
    models[PLACEHOLDER_MODEL] = { name: "Run /connect to set up CLIProxyAPI", tool_call: false, reasoning: false }
  return {
    ...user,
    name: user.name ?? "CLIProxyAPI",
    npm: user.npm ?? "@ai-sdk/openai-compatible",
    options: { ...(baseURL ? { baseURL } : {}), ...((user.options ?? {}) as Json) },
    models,
  }
}
