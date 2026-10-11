// Presentation copied from OpenCodePlus 1.3.5's cliproxyapi/quota/usage-format.ts.
import type { UsageSnapshot, UsageWindow } from "../core/usage.js"

export function usageArguments(input = "") {
  const value = input.trim()
  if (value === "") return false
  if (value === "--all") return true
  return undefined
}

const UNITS = [
  { seconds: 86400, short: "d", long: "day" },
  { seconds: 3600, short: "h", long: "hour" },
  { seconds: 60, short: "m", long: "minute" },
  { seconds: 1, short: "s", long: "second" },
] as const

function windowUnit(seconds: number) {
  const unit = UNITS.find((item) => seconds >= item.seconds && seconds % item.seconds === 0) ?? UNITS[3]
  return { count: Math.round(seconds / unit.seconds), unit }
}
export function windowLabel(window: UsageWindow) {
  const value = windowUnit(window.seconds)
  const duration = `${value.count} ${value.unit.long}${value.count === 1 ? "" : "s"}`
  return window.scope === "all" ? duration : `${duration} · ${window.scope}`
}
export function windowShort(window: UsageWindow) {
  const value = windowUnit(window.seconds)
  return `${value.count}${value.unit.short}`
}
export function percentLabel(remaining: number) {
  const value = Math.max(0, Math.min(100, remaining))
  if (value > 0 && value < 1) return "<1%"
  return `${Math.floor(value)}%`
}
export function exactPercent(remaining: number) {
  return `${Number(Math.max(0, Math.min(100, remaining)).toFixed(1))}%`
}
export function barCells(remaining: number, width: number) {
  const size = Math.max(0, width)
  const filled = Math.min(size, Math.round((Math.max(0, Math.min(100, remaining)) / 100) * size))
  return { filled: "█".repeat(filled), empty: "░".repeat(size - filled) }
}
export function countdown(seconds: number) {
  if (seconds < 60) return "<1m"
  const minutes = Math.ceil(seconds / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days) return `${days}d ${hours}h`
  if (hours) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}
export type WindowState = "normal" | "low" | "critical" | "stale" | "reset" | "dormant" | "unlimited"
export function windowState(window: UsageWindow, snapshot: UsageSnapshot, now: number): WindowState {
  if (window.not_applicable) return "unlimited"
  if (window.dormant) return "dormant"
  if (window.state === "awaiting-confirmation") return "reset"
  if (window.reset <= now) return "reset"
  if (window.state !== undefined) {
    if (!["current", "estimated", "partial"].includes(window.state)) return "stale"
    if (window.updated === undefined || now - window.updated > snapshot.max_age_seconds) return "stale"
  } else if (now - window.observed > snapshot.max_age_seconds) return "stale"
  if (window.remaining <= 10) return "critical"
  if (window.remaining <= 20) return "low"
  return "normal"
}
export function windowTail(window: UsageWindow, state: WindowState, now: number) {
  if (state === "unlimited") return "n/a"
  if (state === "dormant") return "dormant"
  if (state === "reset") return "reset"
  if (state === "stale") return "STALE"
  return countdown(window.reset - now)
}
export function windowDetail(window: UsageWindow, state: WindowState, now: number) {
  const label = windowLabel(window)
  if (state === "unlimited") return `${label} · no limit for this window`
  if (state === "dormant") return `${label} · window has not started`
  if (state === "reset") return `${label} · reset passed; awaiting a fresh reading`
  const when = new Date(window.reset * 1000).toLocaleString(undefined, {
    weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit",
  })
  const age = state === "stale" ? ` · reading ${countdown(now - window.observed)} old` : ""
  return `${label} · ${exactPercent(window.remaining)} left · resets ${when}${age}`
}
