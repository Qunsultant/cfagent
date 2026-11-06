/**
 * #1726 (parent #1717, slice (f)): ONE runtime config switch per
 * divergent E*TRADE MCP-vs-REST pair — the PAYMENTS_FLOW_MODE (#1711)
 * / QUOTE_* (#1725) pattern applied to this domain. Pure module: no
 * Cloudflare imports, no I/O, no network — the port is the resolver,
 * and both surfaces consume it (port-first, cfagent blueprint #1795).
 *
 * Switches (Worker env vars, non-secret, owner-set; this slice sets NO
 * production value — production values are an owner action):
 *   ETRADE_SCAN_MODE       "listings" | "screened"
 *   ETRADE_QUOTE_MODE      "mcp" | "rest"
 *   ETRADE_PREVIEW_MODE    "local" | "broker"
 *   ETRADE_POSITIONS_MODE  "mcp" | "rest"
 *   ETRADE_STATUS_MODE     "mcp" | "rest"
 *   ETRADE_DISCOVERY_MODE  "mcp" | "rest"
 * Values are case-insensitive, surrounding whitespace ignored.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (surface legacy).
 * Carriers: run = the per-request / per-call `mode` field (REST body
 * `mode` or query `?mode=`, MCP input `mode`); session / user = the
 * optional `scopedEtradeModes` carrier on the execution context
 * (McpToolContext.scopedEtradeModes / route ctx scopedEtradeModes,
 * populated by the execution-context owner); global env = the Worker
 * env var. A blank/unset level falls through to the next level. The
 * FIRST non-blank level wins; if that value is unrecognized, the
 * resolution FAILS CLOSED to the surface legacy (invalid=true, level
 * = the winning level) and does NOT fall through to a lower level.
 * Callers must log + audit `etrade.config_error` on invalid.
 *
 * Built-in default per surface = that surface's CURRENT behavior
 * (recorded explicitly so the owner can overturn it later):
 *   MCP surface: scan=listings, quote=mcp, preview=local,
 *     positions=mcp, status=mcp, discovery=mcp.
 *   REST surface: scan=screened, quote=rest, preview=broker,
 *     positions=rest, status=rest, discovery=rest.
 * (A single global env value applies to both surfaces; an owner who
 * sets ETRADE_SCAN_MODE=screened globally must know MCP scans then
 * fail loud — see the screened-mode boundary below — rather than
 * silently running the listings engine.)
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - The E04 execute gate (403 did:agent: / 404 draft-exists / 400
 *   previewed-status / payload binding) is NOT switchable: there is
 *   no mode input on etrade_execute_order, and no switch value can
 *   disable, weaken, or re-route the gate. See
 *   src/services/etradeExecutionGate.ts.
 * - The REST x-user-login gate (401 without it) stands in BOTH modes
 *   on every REST route. MCP contexts are bound to a per-user API
 *   key / app session, so the MCP sessionId IS the caller's login.
 * - Autopilot policy verdicts, the orders-today counter, and the
 *   15-minute expiry scheduler are OrchestratorAgent host
 *   capabilities: they run on the REST surface in both modes and are
 *   unavailable in MCP context in both modes (documented residual
 *   in the #1726 §15 — never silently re-implemented weaker).
 *
 * Per-context behavior matrix (both paths preserved as branches,
 * never deleted):
 * | tool/route        | mcp/local/listings branch          | rest/screened/broker branch        |
 * | market scan (MCP) | listings engine + market_scanned   | THROWS: screened pipeline (Screener- |
 * |                   | audit (legacy verbatim)            | Agent) is not bound in MCP context; |
 * |                   |                                    | use the REST /etrade/screen route. |
 * | /etrade/screen    | listings engine + market_scanned   | ScreenerAgent pipeline + screened   |
 * | (REST)            | audit (new branch, same engine)    | audit + canonical report (legacy)   |
 * | quote (MCP)       | sessionId login, quote_fetched     | env override honored, no audit,     |
 * |                   | audit, symbol required (legacy)    | missing symbol defaults to NVDA     |
 * | /etrade/quote     | symbol required (400 if missing),  | NVDA default + no-cache headers     |
 * | (REST)            | quote_fetched audit                | (legacy)                          |
 * | preview (MCP)     | local draft, option legs REJECTED  | broker draft (previewOrderRemote)   |
 * |                   | loudly (legacy dropped them       | + payload-hash audit; policy/sched/ |
 * |                   | silently)                          | Slack stay REST-only (residual)     |
 * | /etrade/order/    | local draft, option legs rejected  | broker draft + policy gate + expiry |
 * | preview (REST)    | (no policy/schedule/Slack — the    | schedule + Slack ticket (legacy)    |
 * |                   | execute-time policy gate still     |                                   |
 * |                   | applies at REST execute)           |                                   |
 * | positions (MCP)   | reshaped envelope + 2nd accounts   | spread holdings + error-if-         |
 * |                   | call (legacy)                      | unconnected (REST shape)            |
 * | /etrade/positions | reshaped envelope (same as MCP)    | spread holdings + error-if-         |
 * | (REST)            |                                    | unconnected (legacy)                |
 * | auth status (MCP) | no env threading (legacy)          | requestedEnv threaded into the      |
 * |                   |                                    | service (REST construction)         |
 * | /etrade/status    | env override ignored               | requestedEnv from x-environment/    |
 * | (REST)            |                                    | ?env (legacy)                       |
 * | discovery (MCP)   | {count, accounts, asOf} (legacy)   | {count, accounts} + 502-on-empty-   |
 * |                   |                                    | with-upstream-error (REST shape)    |
 * | /etrade/accounts  | {count, accounts, asOf}            | {count, accounts} + 502 (legacy)    |
 * | (REST)            |                                    |                                   |
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in resolution
 * order and unit-pinned, but in production today only run
 * (per-request `mode`) and global env are settable; an admin-owned
 * persisted settings surface is a follow-up, not smuggled in via a
 * store whose keys any caller can write (the #1721 boundary note).
 * The route ctx carrier is populated by no production caller yet.
 */

import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "config/etradeModes",
});

export type EtradeScanMode = "listings" | "screened";
export type EtradeQuoteMode = "mcp" | "rest";
export type EtradePreviewMode = "local" | "broker";
export type EtradePositionsMode = "mcp" | "rest";
export type EtradeStatusMode = "mcp" | "rest";
export type EtradeDiscoveryMode = "mcp" | "rest";

/** One switch's value per surface key, as carried at session/user level. */
export interface EtradeModeValues {
  scan?: unknown;
  quote?: unknown;
  preview?: unknown;
  positions?: unknown;
  status?: unknown;
  discovery?: unknown;
}

/** Session/user carriers for the E*TRADE switches. */
export interface EtradeScopedModes {
  session?: EtradeModeValues;
  user?: EtradeModeValues;
}

/** One level of the resolution order. Blank/unset falls through. */
export interface EtradeModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

export interface ResolvedEtradeSwitch<T extends string> {
  mode: T;
  invalid: boolean;
  raw?: string;
  level: "run" | "session" | "user" | "env" | "builtin";
}

export const ETRADE_SCAN_MODE_SWITCH = "ETRADE_SCAN_MODE" as const;
export const ETRADE_QUOTE_MODE_SWITCH = "ETRADE_QUOTE_MODE" as const;
export const ETRADE_PREVIEW_MODE_SWITCH = "ETRADE_PREVIEW_MODE" as const;
export const ETRADE_POSITIONS_MODE_SWITCH = "ETRADE_POSITIONS_MODE" as const;
export const ETRADE_STATUS_MODE_SWITCH = "ETRADE_STATUS_MODE" as const;
export const ETRADE_DISCOVERY_MODE_SWITCH = "ETRADE_DISCOVERY_MODE" as const;

/** Audit event emitted when a switch value fails closed. */
export function etradeConfigErrorEvent(): string {
  return "etrade.config_error";
}

function normalizeSwitchValue(raw: unknown, valid: string[]): string | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (valid.includes(normalized)) return normalized;
  return "invalid";
}

function resolveSwitch<T extends string>(
  levels: EtradeModeScopeLevels,
  legacy: T,
  valid: string[],
  switchName: string,
): ResolvedEtradeSwitch<T> {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeSwitchValue(value, valid);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      structuredLog.warn(etradeConfigErrorEvent(), {
        message: `[${etradeConfigErrorEvent()}] ${switchName} unrecognized value at ${level}; failing closed to surface legacy`,
        switch: switchName,
        level,
        raw: typeof value === "string" ? value : undefined,
      });
      return {
        mode: legacy,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized as T, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set for one switch from the scoped carrier + run + env. */
export function levelsForEtradeSwitch(
  scoped: EtradeScopedModes | undefined,
  key: keyof EtradeModeValues,
  run: unknown,
  envValue: unknown,
): EtradeModeScopeLevels {
  return { run, session: scoped?.session?.[key], user: scoped?.user?.[key], env: envValue };
}

export function resolveEtradeScanMode(levels: EtradeModeScopeLevels, legacy: EtradeScanMode): ResolvedEtradeSwitch<EtradeScanMode> {
  return resolveSwitch(levels, legacy, ["listings", "screened"], ETRADE_SCAN_MODE_SWITCH);
}

export function resolveEtradeQuoteMode(levels: EtradeModeScopeLevels, legacy: EtradeQuoteMode): ResolvedEtradeSwitch<EtradeQuoteMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], ETRADE_QUOTE_MODE_SWITCH);
}

export function resolveEtradePreviewMode(levels: EtradeModeScopeLevels, legacy: EtradePreviewMode): ResolvedEtradeSwitch<EtradePreviewMode> {
  return resolveSwitch(levels, legacy, ["local", "broker"], ETRADE_PREVIEW_MODE_SWITCH);
}

export function resolveEtradePositionsMode(levels: EtradeModeScopeLevels, legacy: EtradePositionsMode): ResolvedEtradeSwitch<EtradePositionsMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], ETRADE_POSITIONS_MODE_SWITCH);
}

export function resolveEtradeStatusMode(levels: EtradeModeScopeLevels, legacy: EtradeStatusMode): ResolvedEtradeSwitch<EtradeStatusMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], ETRADE_STATUS_MODE_SWITCH);
}

export function resolveEtradeDiscoveryMode(levels: EtradeModeScopeLevels, legacy: EtradeDiscoveryMode): ResolvedEtradeSwitch<EtradeDiscoveryMode> {
  return resolveSwitch(levels, legacy, ["mcp", "rest"], ETRADE_DISCOVERY_MODE_SWITCH);
}

/**
 * #1726 REST-surface convenience: resolve one switch for a route
 * host (run > session > user > global env > REST legacy) and audit
 * etrade.config_error on an invalid winning value (fail-closed).
 * The host is structural ({ scopedEtradeModes, env, audit }) so the
 * dispatcher stays thin: one import, one call per route, no
 * per-switch resolver imports in the dispatcher (the #359 <50 KB
 * dispatcher target). The execute gate never passes through here.
 */
export interface EtradeRestSwitchHost {
  scopedEtradeModes?: EtradeScopedModes;
  env: unknown;
  audit: (type: string, agent: any, payload: Record<string, unknown>) => void;
}

export function resolveEtradeRestSwitch(host: EtradeRestSwitchHost, key: "scan", run: unknown, legacy: EtradeScanMode): EtradeScanMode;
export function resolveEtradeRestSwitch(host: EtradeRestSwitchHost, key: "quote", run: unknown, legacy: EtradeQuoteMode): EtradeQuoteMode;
export function resolveEtradeRestSwitch(host: EtradeRestSwitchHost, key: "preview", run: unknown, legacy: EtradePreviewMode): EtradePreviewMode;
export function resolveEtradeRestSwitch(host: EtradeRestSwitchHost, key: "positions", run: unknown, legacy: EtradePositionsMode): EtradePositionsMode;
export function resolveEtradeRestSwitch(host: EtradeRestSwitchHost, key: "status", run: unknown, legacy: EtradeStatusMode): EtradeStatusMode;
export function resolveEtradeRestSwitch(host: EtradeRestSwitchHost, key: "discovery", run: unknown, legacy: EtradeDiscoveryMode): EtradeDiscoveryMode;
export function resolveEtradeRestSwitch(
  host: EtradeRestSwitchHost,
  key: keyof EtradeModeValues,
  run: unknown,
  legacy: string,
): string {
  const table: Record<keyof EtradeModeValues, { envVar: string; resolve: (levels: EtradeModeScopeLevels, legacy: string) => ResolvedEtradeSwitch<string> }> = {
    scan: { envVar: ETRADE_SCAN_MODE_SWITCH, resolve: (l, g) => resolveEtradeScanMode(l, g as EtradeScanMode) as unknown as ResolvedEtradeSwitch<string> },
    quote: { envVar: ETRADE_QUOTE_MODE_SWITCH, resolve: (l, g) => resolveEtradeQuoteMode(l, g as EtradeQuoteMode) as unknown as ResolvedEtradeSwitch<string> },
    preview: { envVar: ETRADE_PREVIEW_MODE_SWITCH, resolve: (l, g) => resolveEtradePreviewMode(l, g as EtradePreviewMode) as unknown as ResolvedEtradeSwitch<string> },
    positions: { envVar: ETRADE_POSITIONS_MODE_SWITCH, resolve: (l, g) => resolveEtradePositionsMode(l, g as EtradePositionsMode) as unknown as ResolvedEtradeSwitch<string> },
    status: { envVar: ETRADE_STATUS_MODE_SWITCH, resolve: (l, g) => resolveEtradeStatusMode(l, g as EtradeStatusMode) as unknown as ResolvedEtradeSwitch<string> },
    discovery: { envVar: ETRADE_DISCOVERY_MODE_SWITCH, resolve: (l, g) => resolveEtradeDiscoveryMode(l, g as EtradeDiscoveryMode) as unknown as ResolvedEtradeSwitch<string> },
  };
  const entry = table[key];
  const resolved = entry.resolve(
    levelsForEtradeSwitch(host.scopedEtradeModes, key, run, (host.env as Record<string, unknown> | null)?.[entry.envVar]),
    legacy,
  );
  if (resolved.invalid) {
    host.audit(etradeConfigErrorEvent(), "trading", {
      switch: entry.envVar,
      raw: resolved.raw,
      level: resolved.level,
      failedClosedTo: resolved.mode,
    });
  }
  return resolved.mode;
}
