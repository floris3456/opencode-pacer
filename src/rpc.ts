// The Pacer meter RPC. The server half records quota replies (X-Pacer-Quota)
// and Pacer's shared usage view; the CLI half reads the snapshot and subscribes
// to updates to render the sidebar. JSON Schema only, so this contract costs no
// runtime dependency and either half can import it.

import { Rpc } from "@opencode/plugin/rpc"
import type { MeterSnapshot } from "./core/meter.js"

/** Event payload of `meter`: the full snapshot, see core/meter.ts. */
export interface PacerMeterEvent {
  snapshot: MeterSnapshot
}

export const PacerRpc = Rpc.define({
  id: "opencode-pacer",
  methods: {
    /** Cached meter plus the catalogue's providers for the selected prompt model. */
    usage: {
      input: { type: "object", properties: { providerID: { type: "string" }, modelID: { type: "string" } }, required: ["providerID", "modelID"], additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    /** Read-only preview for one chat; credentials and capabilities remain server-side. */
    nextUse: {
      input: { type: "object", properties: { sessionID: { type: "string" } }, required: ["sessionID"], additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
    /** The current meter snapshot (credentials, windows, last served per chat). */
    snapshot: {
      input: { type: "object", additionalProperties: false },
      output: { type: "object", additionalProperties: true },
    },
  },
  events: {
    meter: {
      schema: { type: "object", additionalProperties: true },
    },
  },
})
