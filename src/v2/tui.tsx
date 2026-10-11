/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import type { Context } from "@opencode/plugin/tui/context"
import { createUsage } from "./usage-view.js"

export function setup(context: Context) {
  return createUsage(context)
}
export default Plugin.define({ id: "opencode-pacer", setup })
