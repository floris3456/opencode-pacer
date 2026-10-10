// CPA catalogue facts (core/models.ts) → OpenCode 2.x model definitions.
// Pure: the server half applies these inside its provider transform, and the
// unit tests exercise them without an OpenCode host.

import { isClaude, type CatalogModel } from "../core/models.js"
import type { Price } from "../core/protocol.js"

/** The runtime package for CPA's OpenAI-compatible API. */
export const DEFAULT_PACKAGE = "@opencode/ai/providers/openai-compatible"
/** CPA's Anthropic Messages relay (prompt caching, thinking as Claude defines them). */
export const ANTHROPIC_COMPATIBLE = "@opencode/ai/providers/anthropic-compatible"

const ANTHROPIC_PACKAGES = new Set([ANTHROPIC_COMPATIBLE, "@opencode/ai/providers/anthropic"])
/** Packages Core spells with OpenAI Responses reasoning settings. */
const RESPONSES = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/azure/responses",
])

type Json = Record<string, unknown>

export interface Cost {
  input: number
  output: number
  cache: { read: number; write: number }
  tier?: { type: "context"; size: number }
}

/** V2 costs are an array of USD per million token tiers, not one flat object. */
export function pacerCosts(price: Price): Cost[] {
  const cost = (value: { input: number; output: number; cache_read?: number; cache_write?: number }): Cost => ({
    input: value.input,
    output: value.output,
    cache: { read: Math.max(0, value.cache_read ?? 0), write: Math.max(0, value.cache_write ?? 0) },
  })
  return [
    cost(price),
    ...(price.context_tiers ?? [])
      .filter((tier) => Number.isSafeInteger(tier.above_tokens) && tier.above_tokens > 0)
      .map((tier) => ({ ...cost(tier.price), tier: { type: "context" as const, size: tier.above_tokens } })),
  ]
}

export interface Variant {
  id: string
  settings?: Json
}

/** Effort variants the way Core spells them for the provider's package. */
export function spellVariants(pkg: string | undefined, levels: readonly string[]): Variant[] {
  if (levels.length === 0 || pkg === undefined) return []
  if (RESPONSES.has(pkg))
    return levels.map((effort) => ({
      id: effort,
      settings: { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    }))
  if (pkg === DEFAULT_PACKAGE) return levels.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }))
  return []
}

/** The model facts Core uses to decide Anthropic thinking. */
export interface AnthropicModel {
  id: string
  modelID?: string
  limit: { output: number }
}

function claudeInfo(model: AnthropicModel) {
  const id = model.modelID ?? model.id
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(id)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id)
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase()
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return {
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    opus45: family === "opus" && major === 4 && minor === 5,
  }
}

/**
 * Anthropic-spelled effort variants for one model, mirroring Core's model-aware
 * choice: Claude 3.7 and 4.5 take explicit `enabled`+`budgetTokens` thinking,
 * newer models add `effort` to adaptive thinking.
 */
export function anthropicVariants(model: AnthropicModel, levels: readonly string[]): Variant[] {
  if (levels.length === 0) return []
  const info = claudeInfo(model)
  const budget = Math.min(16_000, model.limit.output - 1)
  const manual = info.manual && !info.opus45
  if ((manual || info.opus45) && budget < 1024) return []
  return levels.map((effort) => {
    if (manual) return { id: effort, settings: { thinking: { type: "enabled", budgetTokens: budget } } }
    if (info.opus45)
      return { id: effort, settings: { thinking: { type: "enabled", budgetTokens: budget }, effort } }
    return { id: effort, settings: { thinking: { type: "adaptive", display: "summarized" }, effort } }
  })
}

/** Core-spelled variants for the model's package: Anthropic is model-aware, the rest is not. */
export function variantsFor(model: AnthropicModel, pkg: string | undefined, levels: readonly string[]): Variant[] {
  if (pkg !== undefined && ANTHROPIC_PACKAGES.has(pkg)) return anthropicVariants(model, levels)
  return spellVariants(pkg, levels)
}

/** The fields applyCatalogueModel touches on a model draft. */
export interface ModelDraft {
  name?: string
  modelID?: string
  package?: string
  cost?: Cost[]
  capabilities?: { tools: boolean; input: string[]; output: string[] }
  limit?: { context: number; input?: number; output: number }
  variants?: Variant[]
}

/** The model half of the provider editor, structurally. */
export interface ProviderModelsEditor {
  models: {
    update(providerID: string, modelID: string, update: (model: ModelDraft) => void): void
  }
}

function withInput<T extends { input?: number }>(limit: T, input: number | undefined): T {
  const { input: _ignored, ...rest } = limit
  return (input === undefined ? rest : { ...rest, input }) as T
}

/**
 * Applies one catalogue model to the provider's inventory (upsert). Claude
 * models point at CPA's Anthropic Messages relay; a package the user already
 * wrote wins. Limits, capabilities, costs and reasoning-effective variants are
 * spelled the way the model's runtime package expects.
 */
export function applyCatalogueModel(
  editor: ProviderModelsEditor,
  providerID: string,
  item: CatalogModel,
  pkg: string | undefined,
): void {
  editor.models.update(providerID, item.id, (model) => {
    model.name = item.name
    model.modelID = item.id
    if (item.price) model.cost = pacerCosts(item.price)
    const userPackage = model.package !== undefined && model.package !== ANTHROPIC_COMPATIBLE
    const relayed = isClaude(item) && !userPackage
    if (relayed) model.package = ANTHROPIC_COMPATIBLE
    model.capabilities = { tools: item.kind === "chat", input: [...item.input], output: [...item.outputModalities] }
    // CPA owns the window: its input limit is set or cleared with the context.
    let limit = { ...(model.limit ?? { context: 0, output: 0 }) }
    if (item.context !== undefined) limit = withInput({ ...limit, context: item.context }, item.inputLimit)
    if (item.output !== undefined) limit.output = item.output
    model.limit = limit
    // Variants are spelled after the limit so model-aware Anthropic budgets see the output.
    if (!userPackage)
      model.variants =
        item.reasoning.mode === "levels"
          ? structuredClone(
              variantsFor(
                { id: item.id, limit: { output: limit.output } },
                relayed ? ANTHROPIC_COMPATIBLE : pkg,
                item.reasoning.levels,
              ),
            )
          : []
  })
}