/** @jsxImportSource @opentui/solid */
// One package for both hosts: opencode 1.x reads `tui()` and opencode 2.x reads
// `id` + `setup()`. Each implementation is imported lazily so a 1.x TUI never
// needs the 2.x packages and a 2.x TUI never needs the 1.x ones.

import tuiModule from "./v1/tui.js"

export default {
  id: "opencode-pacer",
  tui: tuiModule.tui,
  async setup(context: unknown) {
    const module = await import("./v2/tui.js")
    return module.setup(context as never)
  },
}