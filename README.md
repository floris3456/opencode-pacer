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
models through another API, for example `"@opencode/ai/providers/openai"` for OpenAI Responses. `/usage` switches the
sidebar between this chat's provider and all accounts.

**OpenCodePlus**: in progress.

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
bunx tsc --noEmit
```

`test/hosts/` runs real opencode builds against a fake CPA with Pacer (see the scripts' headers).

## License

MIT
