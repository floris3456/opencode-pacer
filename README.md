# opencode-pacer

[CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA) in [opencode](https://opencode.ai), and the quota
meter of [Pacer](#pacer), the CPA plugin that places chats on the account whose quota would otherwise expire unused.

- **/connect → CLIProxyAPI**: enter your CPA URL and API key. That's all the setup.
- **Model sync**: every model your CPA serves, with its context and output limits, input types and exactly the
  reasoning levels CPA accepts. Claude models go through CPA's Anthropic Messages relay (prompt caching, thinking).
- **Prices**: with Pacer, each model carries the price Pacer values usage with (yours, the imported book, or
  models.dev), so opencode's cost display matches Pacer's usage page.
- **Usage meter**: with Pacer, a "Usage" section in the session sidebar shows every account's quota windows: % left,
  a bar and a countdown to the reset. Every reply carries the quota of the account that served it, so the meter is
  current without polling any provider.

Works without Pacer too (connect and model sync only). Pacer works without this plugin: a client without it simply
switches accounts when Pacer moves its chat.

## Install

**opencode 1.x** (`opencode-ai`): add the plugin to both configs, or run `opencode plugin opencode-pacer`.

```jsonc
// ~/.config/opencode/opencode.json
{ "plugin": ["opencode-pacer"] }
// ~/.config/opencode/tui.json
{ "plugin": ["opencode-pacer"] }
```

Then run `/connect`, choose **CLIProxyAPI**, and enter the URL (for example `https://cpa.example.com/v1`) and your
CPA API key. The key is only sent to that URL's origin.

**opencode 2.x** (`@opencode/cli`): run `opencode plugin add opencode-pacer`, or list the package (or a local checkout)
under `plugins`. The server half and the sidebar both load from that one entry.

```jsonc
// ~/.config/opencode/opencode.json
{ "plugins": ["opencode-pacer"] }
```

Then run `/connect`, choose **CLIProxyAPI**, and enter the URL and API key as above. The plugin supplies the provider,
every model with its limits and prices, and sends Claude models through CPA's Anthropic Messages relay, so drop the URL,
key and models from any `providers.cliproxyapi` you defined by hand. Keep only a `package` there to send the other
models through another API, for example `"@opencode/ai/providers/openai"` for OpenAI Responses. `/usage` opens the
credential usage popup; the sidebar stays scoped to the selected model's providers.

**OpenCodePlus**: in progress.

## Account-switch summaries (OpenCode 2.x)

Claude chat requests ask Pacer for `compact_on_switch`. When Pacer replies with
`409 quota_compact_required`, the plugin turns that refusal into a context-overflow
response. OpenCode writes a summary using Claude Haiku, then automatically retries
with the chat's original model and the new checkpoint. No extra user message is needed.
Ordinary compaction keeps your configured summary model. A second switch refusal
after the summary stops with an error instead of summarising repeatedly.

Enabled by default when Pacer is detected. Configure it through plugin options:

```jsonc
{
  "plugins": [{
    "package": "opencode-pacer",
    "options": {
      "accountSwitch": true,
      "compactionModel": "cliproxyapi/claude-haiku-5-5"
    }
  }]
}
```

Without `compactionModel`, the plugin selects a Claude Haiku model from CPA's
catalogue, or keeps the normal summary model if none is available. An explicit
`agents.compaction.model` setting takes precedence over the plugin's temporary
override in stock v2; leave that unset to use Haiku only for switch summaries. Set
`accountSwitch: false` to disable handoff claims. Automatic compaction must be
enabled for automatic recovery; otherwise run `/compact` before retrying.

Stock v2's summary-agent model is location-wide: another chat compacting during
the brief handoff window may also use Haiku. The override is cleared on the resumed
request, execution completion/failure/interruption, or after ten minutes.
Warming (`generate`) requests also carry claims, but refusals fail the ping rather
than starting compaction. Actual exhausted-account warming behavior still needs
live verification; successful claim acknowledgements alone do not prove it.

## Next credential and live meters (OpenCode 2.x)

The sidebar and `/usage` dialog use OpenCodePlus 1.3.5's compact credential-meter
layout. Sidebar credentials follow the selected prompt model's catalogue providers,
including before its first request. `/usage` opens the selected-model view;
`/usage --all` opens all credentials. In the popup, **a** switches scope, **d**
toggles details, **←/→** page, and **Esc** closes. Popup scope never widens the sidebar.

With a Pacer server that exposes per-chat routing previews, the sidebar shows
**NEXT USE** on Pacer's proposed replacement, separately from **LAST USED**.
**IN USE** marks the credential serving the current turn, immediately from the
primary response header. It clears when the turn ends. Pacer's activity poll also
covers requests awaiting response headers, without an additional polling request.
`dry-run` is labelled explicitly: it is Pacer's preference, not a guarantee of
which credential CPA will actually select. Economic moves appear only after cache
protection expires; forced quota switches can appear sooner. The preview uses
the last request's eligible candidates and current server-side quota/cache evidence.

The visible sidebar refreshes the preview every 15 seconds. Stale or failed reads
clear it; old servers simply show no marker. A chat needs a primary request with
the updated plugin/server first. Preview reads use its private capability, never
expose that capability in the UI, and do not trigger a switch or provider quota call.

Percentages update immediately from each response's `X-Pacer-Quota`, including
known aliases sharing that quota. This is one header decode and an in-memory update,
with UI events pushed immediately and disk persistence throttled. The response hook
performs no extra network request and no per-token processing. Summary/title
responses refresh percentages without replacing the primary chat's LAST USED marker.

V2 also subscribes to Pacer's shared credential changes. Headers from **any user**
update idle viewers immediately through a held usage GET and local RPC events;
the viewing chat does not need to make a request. The subscription reconnects with
an opaque cursor and backs off on errors. Old servers fall back to reading Pacer's
stored view every five seconds. Neither path calls provider quota endpoints.

## Settings you can keep

Anything you write under `provider.cliproxyapi` in `opencode.json` wins over what the plugin syncs: the provider's
name and options, and per-model settings.

## Pacer

Pacer is a CPA plugin (Go) that replaces CPA's fill-first account choice with a pace rule and keeps an independent
usage record. This plugin speaks its client protocol: it declares itself on each request (`X-Pacer-Client`) and reads
the quota Pacer attaches to replies (`X-Pacer-Quota`). See Pacer's `docs/client-protocol.md`.

Pacer reads provider quota meters itself (every 30 minutes at most when an account is idle, never more than once in
15 minutes); this plugin and opencode never call a provider's quota endpoint.

## Develop

```sh
bun install
bun test
bun run typecheck
```

`test/hosts/` runs real opencode builds against a fake CPA with Pacer (see the scripts' headers).

```sh
bun test/hosts/v2-switch.ts /path/to/opencode-v2
REFUSE_AGAIN=1 bun test/hosts/v2-switch.ts /path/to/opencode-v2
```

## License

MIT
