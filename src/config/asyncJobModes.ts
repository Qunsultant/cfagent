/**
 * #1724 (parent #1717, slice (d)): TWO runtime config switches for the
 * async jobs systems — the PAYMENTS_FLOW_MODE (#1711) / ads-revenue
 * (#1721) / NLQ_MODE (#1722) / KNOWLEDGE_MODE (#1723) pattern applied
 * to this domain.
 *
 * Switch 1 — HTTP_DELIVERY_MODE ("sync" | "queued", Worker env var,
 * non-secret, owner-set; this slice sets NO production value):
 *   Governs the delivery decision for /api requests at the DO entry
 *   (OrchestratorAgent.onRequest) AND for MCP tools/call
 *   (handleMCPRequest). Both transports keep BOTH code paths; neither
 *   path is deleted and no endpoint is removed.
 *   "sync"   = run the handler inline (DO routeRequest for HTTP,
 *              executeMCPTool for MCP) and return its result.
 *   "queued" = submit an async job (capability "http.request" for
 *              HTTP, "mcp.tool" for MCP) and return the job receipt
 *              ({jobId, status: "queued", statusUrl: "/api/jobs/{id}"}).
 *   Built-in default = the calling surface's own legacy contract
 *   (there is no single public-route delivery behavior: the legacy
 *   IS the per-prefix rule on HTTP and the submitter rule on MCP):
 *     HTTP: immediate prefixes → "sync"; every other /api-prefixed
 *       or async-eligible request → "queued". The immediate list is
 *       the onRequest list (clear|reset|memory|audit|chat|
 *       chat-activity|screener|etrade|broker|trading|options); the
 *       Worker forwarder list is the same minus chat-activity, and
 *       the Worker grants async-eligibility to a queued-header
 *       immediate request (see src/server.ts) so the override reaches
 *       the DO. Worker special branches (incl. /api/jobs/history and
 *       /api/jobs/reconcile) stand in every mode — they never queue.
 *     MCP: a submitJob submitter present → "queued"; absent → "sync"
 *       (direct execution, the only option without a submitter).
 *   Exclusions stand in EVERY mode: /jobs* endpoints (the async-job
 *   endpoints themselves), /mcp* (its own wrapping rule), and
 *   /schedules* never queue at the DO entry; get_async_job and
 *   list_async_jobs are NEVER wrapped as jobs on the MCP path, in
 *   any mode — they are the synchronous status readers.
 *
 * Switch 2 — JOB_LIST_ENVELOPE ("count" | "nocount", Worker env var,
 * non-secret, owner-set; this slice sets NO production value):
 *   Governs the LIST envelope only.
 *   "count"   = {count, jobs}; "nocount" = {jobs} (no count field).
 *   Built-in default = the calling surface's own legacy envelope:
 *     MCP list_async_jobs → "count"; REST GET /jobs → "nocount".
 *   An explicitly set level overrides BOTH surfaces uniformly.
 *   Single-job reads are NOT switched: MCP get_async_job and REST
 *   GET /jobs/{uuid} both return the FULL record including `result`
 *   already, and list records are result-stripped on both surfaces
 *   already (MCP by the /mcp route context, REST by onRequest).
 *   REST-only POST /jobs/{uuid}/retry is unchanged.
 *
 * Resolution order (owner directive 2026-10-26):
 *   run > session > user > global env > built-in (surface legacy).
 * Carriers: HTTP run = the `x-delivery-mode` request header; REST
 * list run = the `?envelope=` query param; MCP list run = the
 * per-call `envelope` input; MCP tools/call run = the
 * `x-delivery-mode` header on the /mcp POST. Session / user = the
 * optional scoped carriers on the execution context, populated by
 * the execution-context owner; unset carriers fall through to env.
 * A blank/unset level falls through; the FIRST non-blank level wins.
 * An unrecognized winning value FAILS CLOSED to the surface legacy,
 * logged + audited as jobs.config_error, with no fall-through.
 *
 * What the switches do NOT govern (ENFORCEMENT, never opt-out):
 * - Job visibility/tenancy: mas_async_jobs reads stay session-scoped
 *   (sessionKey) in every mode; the AgentDB projection read stays
 *   tenant-scoped and reconcile stays platform-admin-only, in every
 *   mode. No switch value widens a session or tenant boundary, and
 *   no switch value lets a caller disable its own audit scoping.
 * - The three J01 systems stay separate: the outcome sink
 *   (mas_job_outcomes) is NOT merged into mas_async_jobs and is NOT
 *   queryable by async jobId; the AgentDB shard-job projection is
 *   NOT absorbed here (#1729's slice). Queue consumption stays
 *   idempotent (submit schedules executeAsyncJob with
 *   {idempotent: true}; execute claims queued→running atomically).
 * - Caps stand in every mode: async-job payload 17 MB, async-job
 *   result 12 MB, queued HTTP request body 8 MB, REST list limit
 *   default 50 clamped 1–100, outcome list limit default 50 clamped
 *   1–200 at the /autopilot/jobs route, stale-running auto-fail 2 h.
 * - Identity is not switched: HTTP keeps x-user-login / session key,
 *   MCP keeps sessionId, async jobs keep payload userLogin /
 *   session key, in both modes.
 *
 * Boundary, stated honestly: no persisted settings store is
 * introduced here. Session/user carriers are honored in resolution
 * order and unit-pinned, but in production today only run
 * (per-request header / query param / tool input) and global env are
 * settable — the same boundary as #1721/#1722/#1723. The Worker
 * forwarder change is eligibility-only: it can grant
 * x-async-eligible on a queued header (or suppress it on a sync
 * header); the DO entry remains the decider.
 */

/** The two HTTP/MCP delivery variants behind the switch. */
export type HttpDeliveryMode = "sync" | "queued";

/** The HTTP/MCP delivery switch's Worker env var name. */
export const HTTP_DELIVERY_MODE_SWITCH = "HTTP_DELIVERY_MODE" as const;

/** The two job-list envelope variants behind the switch. */
export type JobListEnvelope = "count" | "nocount";

/** The job-list envelope switch's Worker env var name. */
export const JOB_LIST_ENVELOPE_SWITCH = "JOB_LIST_ENVELOPE" as const;

/** Audit event emitted when either jobs switch value fails closed. */
export function jobsConfigErrorEvent(): string {
  return "jobs.config_error";
}

/** One level of the delivery resolution order. Blank/unset falls through. */
export interface HttpDeliveryScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for the delivery switch, as carried by an execution context. */
export interface HttpDeliveryScopedModes {
  session?: unknown;
  user?: unknown;
}

/** One level of the envelope resolution order. Blank/unset falls through. */
export interface JobListScopeLevels {
  run?: unknown;
  session?: unknown;
  user?: unknown;
  env?: unknown;
}

/** Session/user carriers for the envelope switch, as carried by an execution context. */
export interface JobListScopedModes {
  session?: unknown;
  user?: unknown;
}

export interface ResolvedHttpDeliveryMode {
  mode: HttpDeliveryMode;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

export interface ResolvedJobListEnvelope {
  mode: JobListEnvelope;
  /** True only when the winning level held an unrecognized value. */
  invalid: boolean;
  /** The raw winning value, when it was a string (preserved for audit). */
  raw?: string;
  /** Which level won, or "builtin" when every level was blank. */
  level: "run" | "session" | "user" | "env" | "builtin";
}

function normalizeHttpDeliveryValue(raw: unknown): HttpDeliveryMode | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "sync") return "sync";
  if (normalized === "queued") return "queued";
  return "invalid";
}

function normalizeJobListEnvelopeValue(raw: unknown): JobListEnvelope | "invalid" | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") return "invalid";
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return null;
  if (normalized === "count") return "count";
  if (normalized === "nocount") return "nocount";
  return "invalid";
}

/**
 * Resolves HTTP_DELIVERY_MODE in run > session > user > env > builtin
 * order. `legacy` is the calling surface's own legacy delivery (the
 * builtin default: HTTP per-prefix rule, MCP submitter rule). First
 * non-blank level wins; an invalid winner fails closed to `legacy`
 * with invalid=true (no fall-through).
 */
export function resolveHttpDeliveryMode(
  levels: HttpDeliveryScopeLevels,
  legacy: HttpDeliveryMode
): ResolvedHttpDeliveryMode {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeHttpDeliveryValue(value);
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
export function levelsForHttpDelivery(
  scoped: HttpDeliveryScopedModes | undefined,
  run: unknown,
  envValue: unknown
): HttpDeliveryScopeLevels {
  return { run, session: scoped?.session, user: scoped?.user, env: envValue };
}

/**
 * Resolves JOB_LIST_ENVELOPE in run > session > user > env > builtin
 * order. `legacy` is the calling surface's own legacy envelope
 * (MCP list → "count", REST list → "nocount"). First non-blank level
 * wins; an invalid winner fails closed to `legacy` with invalid=true
 * (no fall-through).
 */
export function resolveJobListEnvelope(
  levels: JobListScopeLevels,
  legacy: JobListEnvelope
): ResolvedJobListEnvelope {
  const ordered: Array<["run" | "session" | "user" | "env", unknown]> = [
    ["run", levels.run],
    ["session", levels.session],
    ["user", levels.user],
    ["env", levels.env],
  ];
  for (const [level, value] of ordered) {
    const normalized = normalizeJobListEnvelopeValue(value);
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
export function levelsForJobListEnvelope(
  scoped: JobListScopedModes | undefined,
  run: unknown,
  envValue: unknown
): JobListScopeLevels {
  return { run, session: scoped?.session, user: scoped?.user, env: envValue };
}

/** Applies a resolved list envelope to an already-stripped job list. */
export function applyJobListEnvelope<T>(jobs: T[], mode: JobListEnvelope): { jobs: T[]; count?: number } {
  return mode === "count" ? { count: jobs.length, jobs } : { jobs };
}

/**
 * The DO entry queue decision, pure: queue only an API request that
 * is not a jobs / MCP / schedules endpoint and whose resolved
 * delivery mode is "queued". The caller resolves the mode first
 * (run > session > user > env > per-request legacy); this function
 * only applies the exclusions, which stand in every mode.
 */
export function shouldQueueApiRequest(opts: {
  isApiRequest: boolean;
  isJobsEndpoint: boolean;
  isMcpEndpoint: boolean;
  isScheduleEndpoint: boolean;
  deliveryMode: HttpDeliveryMode;
  /**
   * #2456: the request method. GET/HEAD are reads and are never
   * queued — a read gains nothing from queueing, since the client
   * waits on the replay anyway. An absent method keeps the legacy
   * behavior so callers that do not carry a method are untouched.
   */
  method?: string;
}): boolean {
  const method = typeof opts.method === "string" ? opts.method.toUpperCase() : "";
  if (method === "GET" || method === "HEAD") return false;
  if (!opts.isApiRequest) return false;
  if (opts.isJobsEndpoint || opts.isMcpEndpoint || opts.isScheduleEndpoint) return false;
  return opts.deliveryMode === "queued";
}

/**
 * #3624 (#3605): MCP tools that are strictly synchronous and NEVER wrapped into async jobs.
 * These tools run sub-millisecond local reads/writes (status queries, job
 * retrieval, and immediate Stock Copilot runtime telemetry/controls) and must
 * return inline responses without being queued into background jobs.
 */
export const SYNCHRONOUS_MCP_TOOLS = new Set<string>([
  "get_async_job",
  "list_async_jobs",
  "stock_copilot_status",
  "stock_copilot_control",
  "stock_copilot_introspect",
  "stock_copilot_learnings",
  "stock_copilot_evaluate",
  "stock_copilot_remediate_gaps",
  "get_pipeline_chain_status",
  "list_pipeline_chains",
  "run_pipeline_chain",
  "resume_pipeline_chain",
  "get_feed_job_status",
  "list_feed_jobs",
  "get_enrich_job_status",
  "list_enrich_jobs",
  "get_analyze_job_status",
  "list_analyze_jobs",
  "get_generate_job_status",
  "list_generate_jobs",
  "get_deliver_job_status",
  "list_deliver_jobs",
  "get_payment_budget",
  "check_payment_budget",
  "agentdb.trace.get",
]);

export function isSynchronousMcpTool(name: string): boolean {
  return SYNCHRONOUS_MCP_TOOLS.has(name);
}

