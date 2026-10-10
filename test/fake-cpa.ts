// A fake CLIProxyAPI with (optionally) Pacer, for tests. Records every request.

export interface Seen {
  method: string
  path: string
  headers: Record<string, string>
  /** Model requests: the model asked for, the decoded X-Quota-Handoff claim and the reply status. */
  model?: string
  claim?: Record<string, unknown>
  status?: number
}

export interface FakeOptions {
  key: string
  pacer?: boolean
  /** X-Pacer-Quota value Pacer adds to declared model replies. */
  quota?: (req: Request) => string | undefined
  /**
   * Pacer moving a chat with `compact_on_switch`: lists Claude Haiku too,
   * acknowledges claimed requests (X-Quota-Binding) and refuses the first
   * claimed chat step with 409 `quota_compact_required`.
   */
  accountSwitch?: boolean
  /** Refuse the resumed primary request too, to check the recovery loop guard. */
  refuseAgain?: boolean
}

const HAIKU = { id: "claude-haiku-5-5", owned_by: "anthropic", display_name: "Claude Haiku 5.5", kind: "chat", providers: ["claude"], context_length: 1000000, max_completion_tokens: 128000, input_modalities: ["text", "image"], reasoning: { mode: "levels", levels: ["low", "high", "max"] } }

export function fakeCPA(opts: FakeOptions) {
  const seen: Seen[] = []
  let refused = false
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      const entry: Seen = { method: req.method, path: url.pathname + url.search, headers: Object.fromEntries(req.headers) }
      seen.push(entry)
      const authorised = req.headers.get("authorization") === `Bearer ${opts.key}` || req.headers.get("x-api-key") === opts.key
      if (url.pathname === "/v0/resource/plugins/pacer/events") {
        if (!opts.pacer) return new Response("not found", { status: 404 })
        if (!req.headers.get("authorization"))
          return Response.json({ protocol: 1, mode: "off", pacer: true, client: { version: 1, request_header: "X-Pacer-Client", caps: ["quota"], quota_header: "X-Pacer-Quota", views: ["usage", "prices"] } })
        if (!authorised) return Response.json({ error: "unauthorized" }, { status: 401 })
        if (url.searchParams.get("view") === "prices")
          return Response.json({ protocol: 1, view: "prices", unit: "usd_per_million_tokens", revision: 1, models: { "claude-opus-5-5": { input: 5, output: 25, cache_read: 0.5, cache_write: 6.25, source: "imported" }, "gpt-6-sol": { input: 2, output: 8, source: "manual" } } })
        if (url.searchParams.get("view") === "usage")
          return Response.json({ protocol: 1, view: "usage", now: Math.floor(Date.now() / 1000), credentials: [{ id: "claude-a.json", alias: "A", provider: "claude", shared_with: [], windows: [{ scope: "all", seconds: 18000, left: 70, reset_ms: Date.now() + 3_600_000, state: "current", applies: true }] }] })
        return Response.json({ error: "bad" }, { status: 400 })
      }
      if (!authorised) return Response.json({ error: "unauthorized" }, { status: 401 })
      if (url.pathname === "/v1/models")
        return Response.json({
          object: "list",
          schema: "cliproxyapi.model-details/1",
          data: [
            { id: "claude-opus-5-5", owned_by: "anthropic", display_name: "Claude Opus 5.5", kind: "chat", providers: ["claude"], context_length: 1000000, max_completion_tokens: 128000, input_modalities: ["text", "image"], reasoning: { mode: "levels", levels: ["low", "high", "max"] } },
            { id: "gpt-6-sol", owned_by: "openai", kind: "chat", providers: ["codex"], context_length: 400000, input_length: 272000, max_completion_tokens: 128000, reasoning: { mode: "levels", levels: ["low", "medium", "high", "xhigh"] }, service_tiers: ["priority"] },
            { id: "gpt-image-2", owned_by: "openai", kind: "image", providers: ["codex"], reasoning: { mode: "none" } },
            ...(opts.accountSwitch ? [HAIKU] : []),
          ],
        })
      if (url.pathname === "/v1/chat/completions" || url.pathname === "/v1/messages") {
        const quota = req.headers.get("x-pacer-client") ? opts.quota?.(req) : undefined
        const body = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, unknown>) : {}
        const raw = req.headers.get("x-quota-handoff")
        entry.model = typeof body.model === "string" ? body.model : undefined
        entry.claim = raw ? JSON.parse(Buffer.from(raw, "base64url").toString()) : undefined
        if (opts.accountSwitch && entry.claim?.kind === "primary" && (!refused || opts.refuseAgain)) {
          refused = true
          entry.status = 409
          return Response.json(
            { error: { type: "quota_handoff", code: "quota_compact_required", message: "quota_compact_required: the account is used up" } },
            { status: 409, headers: { "X-Quota-Protocol": "1" } },
          )
        }
        entry.status = 200
        const output = opts.accountSwitch && body.model === HAIKU.id
          ? "## Objective\n- Reply with pong.\n\n## Requirements\n- Reply exactly.\n\n## Decisions\n- None.\n\n## Work State\n### Completed\n- Request received.\n### Active\n- Reply pending.\n### Blocked\n- None.\n\n## Next Move\n1. Reply with pong.\n\n## Relevant Files\n- None.\n\n## Important Context\n- This is a test."
          : "pong"
        const headers = new Headers({ "content-type": body.stream ? "text/event-stream" : "application/json" })
        if (quota) headers.set("X-Pacer-Quota", quota)
        if (entry.claim) {
          headers.set("X-Quota-Protocol", "1")
          headers.set("X-Quota-Binding", Buffer.from(JSON.stringify({ protocol: 1, generation: refused ? 2 : 1, alias: refused ? "B" : "A" })).toString("base64url"))
        }
        if (!body.stream && url.pathname === "/v1/messages")
          return Response.json({ id: "msg_1", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: output }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }, { headers })
        if (!body.stream)
          return new Response(JSON.stringify({ id: "x", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 } }), { headers })
        const sse = (data: unknown, event?: string) => (event ? `event: ${event}\n` : "") + `data: ${JSON.stringify(data)}\n\n`
        let text: string
        if (url.pathname === "/v1/messages") {
          const id = "msg_1"
          text =
            sse({ type: "message_start", message: { id, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } }, "message_start") +
            sse({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }, "content_block_start") +
            sse({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: output } }, "content_block_delta") +
            sse({ type: "content_block_stop", index: 0 }, "content_block_stop") +
            sse({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } }, "message_delta") +
            sse({ type: "message_stop" }, "message_stop")
        } else {
          const chunk = (delta: unknown, finish: string | null, usage?: unknown) => sse({ id: "c1", object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })
          text = chunk({ role: "assistant", content: "pong" }, null) + chunk({}, "stop", { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 }) + "data: [DONE]\n\n"
        }
        return new Response(text, { headers })
      }
      return new Response("not found", { status: 404 })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, seen, stop: () => server.stop(true) }
}
