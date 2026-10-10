// Focused tests for the OpenCode 2.x half: the catalogue mapping is pure, and
// the RPC contract must stay importable without a host.

import { describe, expect, test } from "bun:test"
import type { CatalogModel } from "../src/core/models.js"
import { PacerRpc } from "../src/rpc.js"
import { ANTHROPIC_COMPATIBLE, DEFAULT_PACKAGE, anthropicVariants, applyCatalogueModel, pacerCosts, spellVariants } from "../src/v2/models.js"

const model = (over: Partial<CatalogModel>): CatalogModel => ({
  id: "m",
  name: "M",
  kind: "chat",
  providers: [],
  input: ["text"],
  outputModalities: ["text"],
  reasoning: { mode: "none", levels: [] },
  tiers: [],
  ...over,
})

function capture() {
  const models: Record<string, Record<string, unknown>> = {}
  const editor = {
    models: {
      update(providerID: string, modelID: string, update: (draft: never) => void) {
        const draft = (models[modelID] ??= { id: modelID, modelID, limit: { context: 0, output: 0 } })
        update(draft as never)
      },
    },
  }
  return { editor, models }
}

describe("opencode 2.x model mapping", () => {
  test("prices become a cost array, context tiers included", () => {
    const costs = pacerCosts({
      input: 5,
      output: 25,
      cache_read: 0.5,
      cache_write: 6.25,
      source: "imported",
      context_tiers: [{ above_tokens: 200_000, price: { input: 10, output: 37.5 } }],
    })
    expect(costs.length).toBe(2)
    expect(costs[0]).toEqual({ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } })
    expect(costs[1]?.tier).toEqual({ type: "context", size: 200_000 })
    expect(costs[1]?.input).toBe(10)
  })

  test("openai-compatible effort variants and no variants for unknown packages", () => {
    expect(spellVariants(DEFAULT_PACKAGE, ["low", "high"])).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ])
    expect(spellVariants(undefined, ["low"])).toEqual([])
    expect(spellVariants("@example/other", ["low"])).toEqual([])
  })

  test("Anthropic variants are model-aware", () => {
    expect(anthropicVariants({ id: "claude-opus-4-5", limit: { output: 64_000 } }, ["high"])).toEqual([
      { id: "high", settings: { thinking: { type: "enabled", budgetTokens: 16_000 }, effort: "high" } },
    ])
    expect(anthropicVariants({ id: "claude-opus-5-5", limit: { output: 128_000 } }, ["high"])).toEqual([
      { id: "high", settings: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" } },
    ])
    // Manual thinking needs headroom for its budget; without it, no variants.
    expect(anthropicVariants({ id: "claude-3-7-sonnet", limit: { output: 500 } }, ["high"])).toEqual([])
  })

  test("a Claude catalogue model relays through CPA's Messages endpoint", () => {
    const { editor, models } = capture()
    applyCatalogueModel(
      editor as never,
      "cliproxyapi",
      model({
        id: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        ownedBy: "anthropic",
        context: 1_000_000,
        output: 128_000,
        input: ["text", "image"],
        price: { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, source: "imported" },
        reasoning: { mode: "levels", levels: ["low", "high", "max"] },
      }),
      DEFAULT_PACKAGE,
    )
    const claude = models["claude-opus-5-5"] as Record<string, any>
    expect(claude.package).toBe(ANTHROPIC_COMPATIBLE)
    expect(claude.limit).toEqual({ context: 1_000_000, output: 128_000 })
    expect(claude.capabilities).toEqual({ tools: true, input: ["text", "image"], output: ["text"] })
    expect(claude.cost[0]).toEqual({ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } })
    expect(claude.variants.map((v: any) => v.id)).toEqual(["low", "high", "max"])
  })

  test("the input limit is set and cleared together with the context", () => {
    const { editor, models } = capture()
    applyCatalogueModel(editor as never, "cliproxyapi", model({ id: "gpt-6-sol", context: 400_000, inputLimit: 272_000, output: 128_000, ownedBy: "openai" }), DEFAULT_PACKAGE)
    expect((models["gpt-6-sol"] as any).limit).toEqual({ context: 400_000, input: 272_000, output: 128_000 })
    applyCatalogueModel(editor as never, "cliproxyapi", model({ id: "gpt-6-sol", context: 300_000, output: 128_000, ownedBy: "openai" }), DEFAULT_PACKAGE)
    expect((models["gpt-6-sol"] as any).limit).toEqual({ context: 300_000, output: 128_000 })
  })

  test("a package the user set wins over the relay", () => {
    const { editor, models } = capture()
    editor.models.update("cliproxyapi", "claude-x", (draft: any) => {
      draft.package = "@example/custom"
    })
    applyCatalogueModel(editor as never, "cliproxyapi", model({ id: "claude-x", ownedBy: "anthropic", output: 1_000 }), DEFAULT_PACKAGE)
    const claude = models["claude-x"] as Record<string, any>
    expect(claude.package).toBe("@example/custom")
    expect(claude.variants).toBeUndefined()
  })

  test("the RPC contract is importable without a host", () => {
    expect((PacerRpc as { id?: string }).id).toBe("opencode-pacer")
  })
})