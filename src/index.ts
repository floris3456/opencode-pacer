// One package for both hosts. opencode 1.x calls `server()` and opencode 2.x
// reads `id` + `setup()`; each implementation is imported lazily so a 1.x host
// never needs the 2.x packages and a 2.x host never needs the 1.x ones.

import server from "./v1/server.js"

export default {
  id: "opencode-pacer",
  server,
  async setup(ctx: unknown) {
    const module = await import("./v2/server.js")
    return module.setup(ctx as never)
  },
}