// The account-switch protocol pieces (core/switch.ts): the claim, CPA's
// acknowledgement, its refusal, and the replies put in place of that refusal.

import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  BINDING_HEADER,
  PROTOCOL_HEADER,
  claim,
  compactRefusal,
  compactRequired,
  newBinding,
  parseBinding,
  refusedAgainReply,
  summaryFirstReply,
} from "../src/core/switch.js"

const decode = (value: string) => JSON.parse(Buffer.from(value, "base64url").toString()) as Record<string, unknown>
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")

describe("claim", () => {
  test("names the chat, route and checkpoint, and sends only the capability's digest", () => {
    const binding = { capability: "secret", generation: 3 }
    const body = decode(
      claim({ installation: "inst", session: "ses_1", route: "cliproxyapi/claude-opus-5-5", kind: "primary", binding, checkpoint: "msg_9" }),
    )
    expect(body).toMatchObject({
      protocol: 1,
      installation: "inst",
      session: "ses_1",
      route: "cliproxyapi/claude-opus-5-5",
      kind: "primary",
      checkpoint: "msg_9",
      generation: 3,
      portable: true,
      compact_on_switch: true,
    })
    expect(body.capability).toBe(createHash("sha256").update("secret").digest("hex"))
    expect(JSON.stringify(body)).not.toContain("secret")
  })

  test("a new binding has a private 32-byte capability and generation 0", () => {
    const binding = newBinding()
    expect(binding.capability).toMatch(/^[a-f0-9]{64}$/)
    expect(binding.generation).toBe(0)
  })
})

describe("parseBinding", () => {
  const headers = (binding: unknown, protocol = "1") =>
    new Headers({ [PROTOCOL_HEADER]: protocol, [BINDING_HEADER]: typeof binding === "string" ? binding : encode(binding) })

  test("reads the generation and serving account", () => {
    expect(parseBinding(headers({ protocol: 1, generation: 2, alias: "ilse" }))).toEqual({ generation: 2, alias: "ilse" })
  })

  test("ignores a missing protocol, a malformed value or a bad generation", () => {
    expect(parseBinding(headers({ protocol: 1, generation: 2, alias: "a" }, "2"))).toBeUndefined()
    expect(parseBinding(headers("not+base64url"))).toBeUndefined()
    expect(parseBinding(headers({ protocol: 1, generation: -1, alias: "a" }))).toBeUndefined()
    expect(parseBinding(new Headers())).toBeUndefined()
  })
})

describe("compactRequired", () => {
  const refusal = (body: unknown, status = 409, protocol = "1") =>
    new Response(JSON.stringify(body), { status, headers: { [PROTOCOL_HEADER]: protocol } })

  test("recognises the code, or the code prefixing the message", async () => {
    expect(await compactRequired(refusal({ error: { type: "quota_handoff", code: "quota_compact_required" } }))).toBe(true)
    expect(await compactRequired(refusal({ error: { message: "quota_compact_required: account used up" } }))).toBe(true)
  })

  test("leaves every other reply alone", async () => {
    expect(await compactRequired(refusal({ error: { code: "quota_budget_wait" } }))).toBe(false)
    expect(await compactRequired(refusal({ error: { code: "quota_compact_required" } }, 400))).toBe(false)
    expect(await compactRequired(refusal({ error: { code: "quota_compact_required" } }, 409, "0"))).toBe(false)
    expect(await compactRequired(new Response("conflict", { status: 409, headers: { [PROTOCOL_HEADER]: "1" } }))).toBe(false)
  })

  test("does not consume the reply", async () => {
    const response = refusal({ error: { code: "quota_compact_required" } })
    await compactRequired(response)
    expect(await response.json()).toEqual({ error: { code: "quota_compact_required" } })
  })
})

describe("replies", () => {
  // OpenCode recovers by summarising only from a 4xx whose text it classifies as context overflow.
  const overflow = /context[_ ]length[_ ]exceeded|prompt is too long/i

  test("the refusal becomes a context overflow, which OpenCode summarises and reruns", async () => {
    const reply = summaryFirstReply()
    expect(reply.status).toBe(400)
    expect(JSON.stringify(await reply.json())).toMatch(overflow)
  })

  test("a second refusal is a plain error, never another overflow", async () => {
    const reply = refusedAgainReply()
    expect(reply.status).toBe(400)
    expect(JSON.stringify(await reply.json())).not.toMatch(overflow)
  })
})

describe("compactRefusal", () => {
  const refusal = (body: unknown) => new Response(JSON.stringify(body), { status: 409, headers: { [PROTOCOL_HEADER]: "1" } })
  test("carries the summary models Pacer names, in order", async () => {
    expect(await compactRefusal(refusal({ error: { code: "quota_compact_required", compaction_models: ["claude-sonnet-4-6", 3, "", "claude-haiku-4-5"] } }))).toEqual({ models: ["claude-sonnet-4-6", "claude-haiku-4-5"] })
    expect(await compactRefusal(refusal({ error: { code: "quota_compact_required" } }))).toEqual({ models: [] })
    expect(await compactRefusal(refusal({ error: { code: "quota_budget_wait", compaction_models: ["x"] } }))).toBeUndefined()
  })
})
