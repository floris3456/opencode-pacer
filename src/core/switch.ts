// Account switches with a summary first (Pacer's `compact_on_switch`, wire
// compatible with CPA's quota-handoff protocol 1). Host-neutral.
//
// A client that claims its chat requests (X-Quota-Handoff with
// `compact_on_switch: true`) is not moved to another account with its whole
// history: CPA refuses that one request (409 `quota_compact_required`) before
// it reaches the new account, and admits the chat there once a request names
// a newer checkpoint (summary) than the refused one.

import { createHash, randomBytes, randomUUID } from "node:crypto"

export const CLAIM_HEADER = "X-Quota-Handoff"
export const BINDING_HEADER = "X-Quota-Binding"
export const PROTOCOL_HEADER = "X-Quota-Protocol"
export const COMPACT_REQUIRED = "quota_compact_required"

/** A chat's private claim on one route; only the capability's digest is ever sent. */
export interface Binding {
  capability: string
  generation: number
}

export const newBinding = (): Binding => ({ capability: randomBytes(32).toString("hex"), generation: 0 })
export const newInstallation = () => randomUUID()

export interface ClaimInput {
  installation: string
  session: string
  /** `provider/model` */
  route: string
  kind: string
  binding: Binding
  /** ID of the chat's newest completed summary; "" for none. */
  checkpoint: string
}

/** The X-Quota-Handoff value for one request. */
export function claim(input: ClaimInput): string {
  const body = {
    protocol: 1,
    route: input.route,
    installation: input.installation,
    session: input.session,
    request: randomUUID(),
    kind: input.kind,
    capability: createHash("sha256").update(input.binding.capability).digest("hex"),
    auto: true,
    fresh: false,
    portable: true,
    checkpoint: input.checkpoint,
    generation: input.binding.generation,
    compact_on_switch: true,
  }
  return Buffer.from(JSON.stringify(body)).toString("base64url")
}

/** CPA's acknowledgement of an admitted claim: the binding generation and the serving account. */
export function parseBinding(headers: Headers): { generation: number; alias: string } | undefined {
  const value = headers.get(BINDING_HEADER)
  if (headers.get(PROTOCOL_HEADER) !== "1" || !value || value.length > 2048 || !/^[\w-]+$/.test(value)) return undefined
  try {
    const data = JSON.parse(Buffer.from(value, "base64url").toString()) as Record<string, unknown>
    const generation = data.generation
    if (data.protocol !== 1 || typeof generation !== "number" || !Number.isSafeInteger(generation) || generation < 0)
      return undefined
    return { generation, alias: typeof data.alias === "string" ? data.alias : "" }
  } catch {
    return undefined
  }
}

/**
 * Whether a reply is CPA's refusal to move the chat without a summary. The code
 * is `error.code`, or prefixes `error.message` ("quota_compact_required: …").
 */
export async function compactRequired(response: Response): Promise<boolean> {
  return (await compactRefusal(response)) !== undefined
}

/**
 * That refusal, with the models Pacer names to write the summary
 * (`compaction_models`: CPA model names, first choice first; empty when the
 * client decides).
 */
export async function compactRefusal(response: Response): Promise<{ models: string[] } | undefined> {
  if (response.status !== 409 || response.headers.get(PROTOCOL_HEADER) !== "1") return undefined
  const text = await response
    .clone()
    .text()
    .catch(() => "")
  if (text.length > 16384) return undefined
  try {
    const error = (JSON.parse(text) as { error?: { code?: unknown; message?: unknown; compaction_models?: unknown } }).error
    const refused =
      error?.code === COMPACT_REQUIRED ||
      (typeof error?.message === "string" && error.message.startsWith(`${COMPACT_REQUIRED}:`))
    if (!refused) return undefined
    const named = Array.isArray(error?.compaction_models) ? error.compaction_models : []
    return { models: named.filter((model): model is string => typeof model === "string" && model.length > 0).slice(0, 8) }
  } catch {
    return undefined
  }
}

/**
 * The reply put in place of that refusal. Stock OpenCode 2.x has no plugin
 * action for "summarise this chat, then rerun this step", but it does exactly
 * that when a provider rejects a request as too long before any output.
 */
export const summaryFirstReply = () =>
  Response.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "CLIProxyAPI is moving this chat to another account and needs a summary first (context_length_exceeded). " +
          "With automatic compaction off, run /compact and send the message again.",
      },
    },
    { status: 400, headers: { "x-should-retry": "false" } },
  )

/** The reply when CPA refuses the chat again after its summary: no second summary. */
export const refusedAgainReply = () =>
  Response.json(
    {
      type: "error",
      error: {
        type: "invalid_request_error",
        message:
          "CLIProxyAPI refused this chat again after summarising it for an account switch. " +
          "Try again later, or run /compact and send the message again.",
      },
    },
    { status: 400, headers: { "x-should-retry": "false" } },
  )
