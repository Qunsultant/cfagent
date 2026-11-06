/**
 * #1723 (parent #1717, slice (c)): TWO runtime config switches for the
 * knowledge + memory unpaired surfaces — the PAYMENTS_FLOW_MODE (#1711) /
 * ads-revenue (#1721) / NLQ_MODE (#1722) pattern applied to this domain.
 *
 * Switch 1 — KNOWLEDGE_MODE ("search" | "platform", Worker env var,
 * non-secret, owner-set; this slice sets NO production value):
 *   "search"   = KnowledgeSearchCommand legacy: try the AI Search
 *                namespace binding (#3342; formerly the public
 *                endpoint, 10 s abort) → AI-Search chunks; if zero
 *                chunks OR the query matches the platform-keyword regex,
 *                fall back to searchPlatformKnowledge (max 3). Returns
 *                {query, count, chunks (≤5), answer?, message}; on error
 *                (after the fallback attempt) returns the no-throw shape
 *                {error, query, count:0, chunks:[]}.
 *   "platform" = QueryPlatformKnowledgeCommand legacy: always
 *                searchPlatformKnowledge (max 5, optional category
 *                filter), returns {query, count, results, answer}
 *                (no `message`, no AI-search attempt).
 * Both tools honor BOTH modes; neither tool's code path is deleted.
 * The ranking, the 3-vs-5 cap, and the error contract are pinned per
 * mode by tests/knowledge_memory_modes_1723.test.ts.
 *
 * Switch 2 — MEMORY_READ_MODE ("capped" | "uncapped", Worker env var,
 * non-secret, owner-set; this slice sets NO production value). It
 * governs the memory READ CAP ONLY (list presentation — never the
 * existence of a write path, per the #1723 slice guidance):
 *   "capped"   = first MEMORY_READ_CAP (100) rows.
 *   "uncapped" = all rows.
 * Applies to REST GET /memory (presentation slice), MCP
 * manage_session_memory list, and the sqlite://memory/facts resource.
 * Remember/delete/clear are NOT gated by it in any mode.
 *
 * Built-in default — per-surface legacy (recorded explicitly so the
 * owner can overturn it): these surfaces have NO single public-route
 * behavior to default to (there is no REST search route at all, and
 * the MCP surfaces predate the REST memory bridge). So the builtin
 * default is the calling surface's own legacy contract:
 *   knowledge_search → "search"; query_platform_knowledge → "platform";
 *   REST GET /memory → "capped"; MCP list / memory resource → "uncapped".
 * An explicitly set level (run > session > user > env) overrides the
 * legacy on ANY surface. Invalid winning values fail closed to the
 * calling surface's legacy, logged + audited as
 * knowledge.config_error / memory.config_error, with no fall-through
 * to a lower level.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (surface legacy).
 * Carriers: run = the per-call `mode` input (MCP tool input, REST
 * GET /memory `?mode=` query param); session / user = the optional
 * scoped carriers on the execution context (McpToolContext.
 * scopedKnowledgeModes / scopedMemoryModes, route ctx
 * scopedMemoryModes), populated by the execution-context owner;
 * global env = the Worker env var. A blank/unset level falls through;
 * the FIRST non-blank level wins.
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - Knowledge/corpus boundaries: the R2 corpus routes
 *   (POST /knowledge/corpus, GET /knowledge/file) are a different
 *   store from the Vectorize/AI-Search + platform catalog the M01
 *   tools search. Ingesting a corpus doc does NOT make it searchable
 *   by these tools, and this slice builds NO index bridge (a new
 *   feature, not a unification — stated in the PR, not smuggled in).
 *   No switch value merges search into corpus admin or vice versa.
 * - Memory tenancy/session scoping: mas_memory is a global key-value
 *   store (no session column); no switch value creates, removes, or
 *   widens a session boundary. The sqlite://audit/recent resource's
 *   session filter (limit 30) is NOT switched by this slice: a caller
 *   must never be able to configure away its own audit scoping, and
 *   that resource's contract is an M10 adjacency, left verbatim.
 * - Identity is not switched (MCP sessionId, REST route session).
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in resolution
 * order and unit-pinned, but in production today only run
 * (per-call `mode` / `?mode=`) and global env are settable. The MCP
 * resource protocol carries no per-call mode, so the memory resource
 * resolves env > builtin only, and logs (auditing when the caller
 * supplies an audit channel) on an invalid env value.
 */

/** The two knowledge contract variants behind the switch. */
export type KnowledgeMode = "search" | "platform";

/** The knowledge switch's Worker env var name. */
export const KNOWLEDGE_MODE_SWITCH = "KNOWLEDGE_MODE" as const;

/** Audit event emitted when a knowledge switch value fails closed. */
export function knowledgeConfigErrorEvent(): string {
  return "knowledge.config_error";
}

/** The two memory-read cap variants behind the switch. */
export type MemoryReadMode = "capped" | "uncapped";

/** The memory-read switch's Worker env var name. */
export const MEMORY_READ_MODE_SWITCH = "MEMORY_READ_MODE" as const;

/** REST GET /memory legacy cap, shared by every capped surface. */
export const MEMORY_READ_CAP = 100 as const;

/** Audit event emitted when a memory-read switch value fails closed. */
export function memoryConfigErrorEvent(): string {
  return "memory.config_error";
}

/** One level of the resolution order. Blank/unset falls through. */
export interface KnowledgeModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for the knowledge switch, as carried by an execution context. */
export interface KnowledgeScopedModes {
  session?: unknown;
  user?: unknown;
}

/** One level of the resolution order. Blank/unset falls through. */
export interface MemoryReadModeScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for the memory-read switch, as carried by an execution context. */
export interface MemoryScopedModes {
  session?: unknown;
  user?: unknown;
}

export interface ResolvedKnowledgeMode {
  mode: KnowledgeMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export interface ResolvedMemoryReadMode {
  mode: MemoryReadMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeKnowledgeValue(raw: unknown): KnowledgeMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "search") return "search";
  if (normalized === "platform") return "platform";
  return "invalid";
}

function normalizeMemoryReadValue(raw: unknown): MemoryReadMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "capped") return "capped";
  if (normalized === "uncapped") return "uncapped";
  return "invalid";
}

/**
 * Resolves KNOWLEDGE_MODE in run > session > user > env > builtin
 * order. `legacy` is the calling tool's own legacy contract (the
 * builtin default). First non-blank level wins; an invalid winner
 * fails closed to `legacy` with invalid=true (no fall-through).
 */
export function resolveKnowledgeMode(
  levels: KnowledgeModeScopeLevels,
  legacy: KnowledgeMode
): ResolvedKnowledgeMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeKnowledgeValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: legacy,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set from the scoped carrier + run + env. */
export function levelsForKnowledge(
  scoped: KnowledgeScopedModes | undefined,
  run: unknown,
  envValue: unknown
): KnowledgeModeScopeLevels {
  return { run, session: scoped?.session, user: scoped?.user, env: envValue };
}

/**
 * Resolves MEMORY_READ_MODE in run > session > user > env > builtin
 * order. `legacy` is the calling surface's own legacy cap (the
 * builtin default). First non-blank level wins; an invalid winner
 * fails closed to `legacy` with invalid=true (no fall-through).
 */
export function resolveMemoryReadMode(
  levels: MemoryReadModeScopeLevels,
  legacy: MemoryReadMode
): ResolvedMemoryReadMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeMemoryReadValue(value);
    if (normalized === null) continue;
    if (normalized === "invalid") {
      return {
        mode: legacy,
        invalid: true,
        raw: typeof value === "string" ? value : undefined,
        level,
      };
    }
    return { mode: normalized, invalid: false, raw: typeof value === "string" ? value : undefined, level };
  }
  return { mode: legacy, invalid: false, raw: undefined, level: "builtin" };
}

/** Builds the level set from the scoped carrier + run + env. */
export function levelsForMemory(
  scoped: MemoryScopedModes | undefined,
  run: unknown,
  envValue: unknown
): MemoryReadModeScopeLevels {
  return { run, session: scoped?.session, user: scoped?.user, env: envValue };
}

/** Applies a resolved memory-read mode to an already-ordered row list. */
export function applyMemoryReadCap<T>(rows: T[], mode: MemoryReadMode): T[] {
  return mode === "capped" ? rows.slice(0, MEMORY_READ_CAP) : rows;
}
