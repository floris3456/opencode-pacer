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

**opencode 2.x** (`@opencode/cli`) and **OpenCodePlus**: in progress.

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
