/**
 * #1765 (parent #1717, F-41 / PRV-001–PRV-004 / PRV-006): Privacy/DSAR
 * port — erasure cascade, data export, ADMT notice/opt-out, Sec-GPC,
 * and the SHARED retention registry.
 *
 * Pure module: no Cloudflare imports, no I/O, no network. The port
 * is the contract; the routes in ./privacyRoutes.ts consume it and
 * src/server.ts wires it to the session store. Port-first, per the
 * blueprint restated by #1795/#1798 (cloud-native but
 * cloud-agnostic): nothing here knows about Durable Objects, KV,
 * or Vectorize — adapters do, and they are registered by the
 * caller, never invented by this module.
 *
 * VERIFIED AGAINST CURRENT MAIN (2026-11-01, head 3a55498c):
 *  - No Sec-GPC parsing exists anywhere in src/ (grep: zero hits).
 *  - No /api/privacy route exists in src/server.ts.
 *  - No per-subject delete exists on any DO class (grep for
 *    deleteUser/erase/purgeUser across src/agents: zero hits).
 *  - Session deletion exists (deleteSession in
 *    src/security/session.ts); the cascade's session leg is the
 *    one leg with a verified production mechanism, and it deletes
 *    the subject's privacy record + clears the session cookie —
 *    it cannot enumerate the subject's OTHER sessions, because
 *    KvLike has no list operation (src/security/kvResilience.ts).
 *    That enumeration gap is recorded in the §15 report, not
 *    papered over.
 *  - Vectorize has no per-subject vector key on current main:
 *    vectors are keyed by report/plan/outcome id
 *    (src/agents/aiSearchPaths.ts, src/agentic/compositionMemory.ts),
 *    never by subject. A Vectorize erasure leg therefore cannot be
 *    implemented honestly in this slice; it is registered as
 *    `deferred` by the server wiring and reported as such, never
 *    silently omitted and never claimed erased.
 *  - Retention on current main: the nightly mas_messages pass
 *    (src/server.ts scheduled handler, issue #255) plus the #635
 *    task-ledger prunes (ResearchAgent/ScreenerAgent
 *    pruneExpired*Tasks, driven by OrchestratorAgent maintenance).
 *    The registry below is the SHARED extension point for the
 *    #1766 slice: #1766 adds its tables/rules to this registry
 *    and its snapshot/orphan/audit work around it — it does not
 *    build a second retention mechanism.
 *
 * SECURITY GUARD: none of these switches lets a caller disable
 * their own enforcement. The ADMT opt-out changes which decision
 * path serves the subject (ADMT vs deterministic static rules);
 * it never disables an IAAA gate, a payment HITL gate, or an
 * audit write. GPC can only ADD opt-outs (applyGpcToPreferences
 * is monotone: it never clears an existing opt-out).
 */

import { resolvePrivacyModeScoped } from "../config/privacyModes";

/** Legacy env-only resolver (kept for env-level parity). */
export function resolvePrivacyDsarMode(envValue: unknown): {
  mode: "standard" | "strict";
  invalid: boolean;
} {
  const resolved = resolvePrivacyModeScoped({ env: envValue });
  return { mode: resolved.mode, invalid: resolved.invalid };
}

/** Re-exported for route/call-site convenience. */
export const PRIVACY_DSAR_MODE_SWITCH = "PRIVACY_DSAR_MODE" as const;

// ---------------------------------------------------------------- Sec-GPC

/**
 * PRV-004: parse the Sec-GPC header (Global Privacy Control).
 * Only the exact value "1" (ignoring surrounding whitespace)
 * opts out. Anything else — "0", "yes", garbage, absent — is
 * not an opt-out. A malformed signal must never be read as
 * consent in either direction; absent means "no signal".
 */
export function parseSecGpc(header: string | null | undefined): boolean {
  return typeof header === "string" && header.trim() === "1";
}

export interface PrivacyPreferences {
  saleSharingOptOut: boolean;
  admtOptOut: boolean;
}

/**
 * PRV-004 enforcement, monotone: a GPC opt-out forces both
 * opt-outs ON. GPC absent never clears an existing opt-out,
 * and GPC present never turns an opt-out off. The subject's
 * stored record can therefore never contradict a live GPC
 * signal the subject just sent.
 */
export function applyGpcToPreferences(
  prefs: PrivacyPreferences,
  gpcOptOut: boolean,
): PrivacyPreferences {
  if (!gpcOptOut) return { ...prefs };
  return { saleSharingOptOut: true, admtOptOut: true };
}

// ---------------------------------------------------------------- ADMT

/** Version of the ADMT pre-use notice text (bump on wording change). */
export const ADMT_NOTICE_VERSION = "admt-notice-v1-1765" as const;

export interface AdmtNotice {
  version: typeof ADMT_NOTICE_VERSION;
  /** Plain-language description of the automated logic in scope. */
  logic: string;
  /** Consequential uses the logic serves (screening, payment drafts). */
  consequentialUses: string[];
  /** The subject's right, and where to exercise it. */
  optOutRight: string;
  /** Route that records the opt-out. */
  optOutRoute: "/api/privacy/preferences";
  /** Effective decision path for this subject right now. */
  effectiveRoute: "admt" | "static";
}

/**
 * PRV-003: the ADMT pre-use notice. Served by GET
 * /api/privacy/status before any ADMT-served decision, and
 * its effectiveRoute is the routing decision: an opted-out
 * subject (stored preference, live GPC, or strict mode
 * without explicit opt-in) is served by the deterministic
 * static rule path, never by ADMT. The static path is a
 * behavior variant, not an enforcement bypass: gates and
 * audit still apply inside it.
 */
export function admtNotice(
  prefs?: PrivacyPreferences,
  opts?: { strictMode?: boolean; admtOptedIn?: boolean },
): AdmtNotice {
  const optedOut = prefs?.admtOptOut === true;
  const strictWithoutOptIn = opts?.strictMode === true && opts?.admtOptedIn !== true;
  return {
    version: ADMT_NOTICE_VERSION,
    logic:
      "Automated research and screening: ResearchAgent and ScreenerAgent " +
      "analyze market data and your saved criteria to rank opportunities, " +
      "and payment drafts may be generated from those results.",
    consequentialUses: [
      "automated options research profiling",
      "automated financial order screening",
      "automated payment draft creation",
    ],
    optOutRight:
      "You may opt out of automated decision-making: opted-out subjects " +
      "are served by a deterministic, static rule-based path instead.",
    optOutRoute: "/api/privacy/preferences",
    effectiveRoute: optedOut || strictWithoutOptIn ? "static" : "admt",
  };
}

// ---------------------------------------------------------------- Erasure

/**
 * One store in the erasure cascade. `erase` deletes every row
 * for the subject and returns the count deleted plus the
 * residual count re-checked afterwards — the cascade trusts
 * the re-check, not the delete's claim. A leg that cannot be
 * keyed by subject in this slice is registered with `deferred`
 * and no erase/count functions: it is reported, never skipped.
 */
export interface ErasureLeg {
  name: string;
  erase?: (subject: string) => Promise<{ deleted: number; residual: number }>;
  count?: (subject: string) => Promise<number>;
  deferred?: string;
}

export interface ErasureLegResult {
  name: string;
  status: "erased" | "failed" | "deferred";
  deleted: number;
  residual: number;
  deferredReason?: string;
  error?: string;
}

export interface ErasureReport {
  subject: string;
  legs: ErasureLegResult[];
  /** True only when every leg erased with zero residuals. */
  complete: boolean;
  residualTotal: number;
  deferred: string[];
  failed: string[];
}

export function buildErasureReport(subject: string, legs: ErasureLegResult[]): ErasureReport {
  const residualTotal = legs.reduce((sum, leg) => sum + leg.residual, 0);
  const deferred = legs.filter((l) => l.status === "deferred").map((l) => l.name);
  const failed = legs.filter((l) => l.status === "failed").map((l) => l.name);
  const complete =
    legs.length > 0 &&
    legs.every((l) => l.status === "erased") &&
    residualTotal === 0;
  return { subject, legs, complete, residualTotal, deferred, failed };
}

/**
 * PRV-001: run the cascade. Legs run in registration order;
 * a leg failure is isolated — it is recorded on that leg and
 * fails the report closed, and it never aborts the remaining
 * legs (a cascade that stops at the first failure would leave
 * later stores unerased while reporting only the first).
 */
export async function eraseSubject(subject: string, legs: ErasureLeg[]): Promise<ErasureReport> {
  const results: ErasureLegResult[] = [];
  for (const leg of legs) {
    if (leg.deferred || !leg.erase) {
      const residual = leg.count ? await leg.count(subject).catch(() => 0) : 0;
      results.push({
        name: leg.name,
        status: "deferred",
        deleted: 0,
        residual,
        deferredReason: leg.deferred ?? "no per-subject erasure mechanism in this slice",
      });
      continue;
    }
    try {
      const outcome = await leg.erase(subject);
      results.push({ name: leg.name, status: "erased", deleted: outcome.deleted, residual: outcome.residual });
    } catch (err) {
      const residual = leg.count ? await leg.count(subject).catch(() => -1) : -1;
      results.push({
        name: leg.name,
        status: "failed",
        deleted: 0,
        residual: residual < 0 ? 0 : residual,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return buildErasureReport(subject, results);
}

// ---------------------------------------------------------------- Export

export interface ExportSourceCoverage {
  source: string;
  status: "included" | "not_wired";
  note: string;
}

export interface ExportPayload {
  subject: string;
  generatedAt: number;
  session: unknown;
  messages: unknown[];
  researchRuns: unknown[];
  screenerRuns: unknown[];
  preferences: PrivacyPreferences;
  /**
   * Which sources the payload actually covers. A source the
   * server cannot read per-subject on current main is listed
   * as not_wired with its reason — the export never implies
   * completeness it does not have. PRV-002's acceptance
   * allows "the absence is a recorded decision": this field
   * IS that record, per source.
   */
  coverage?: ExportSourceCoverage[];
}

/**
 * PRV-002: assemble the consolidated export payload. The
 * assembler takes already-scoped inputs — it never fetches,
 * so it cannot leak another subject's rows: the server
 * wiring loads only the caller's own subject (route gate)
 * and the payload echoes that subject back for audit.
 */
export function buildExportPayload(input: {
  subject: string;
  session?: unknown;
  messages?: unknown[];
  researchRuns?: unknown[];
  screenerRuns?: unknown[];
  preferences?: PrivacyPreferences;
  generatedAt: number;
  coverage?: ExportSourceCoverage[];
}): ExportPayload {
  return {
    subject: input.subject,
    generatedAt: input.generatedAt,
    session: input.session ?? null,
    messages: input.messages ?? [],
    researchRuns: input.researchRuns ?? [],
    screenerRuns: input.screenerRuns ?? [],
    preferences: input.preferences ?? { saleSharingOptOut: false, admtOptOut: false },
    ...(input.coverage ? { coverage: input.coverage } : {}),
  };
}

// ---------------------------------------------------------------- Retention

export interface RetentionRule {
  table: string;
  maxAgeDays: number;
  reason: string;
}

/**
 * PRV-006 — the SHARED retention registry. One rule per
 * growing table; a table with no rule is NOT purged by
 * default (unknown tables are never silently invented, and
 * never silently deleted either — #1766 assigns them).
 * The 30-day bound matches the existing mas_messages pass
 * (issue #255) and the #635 task-ledger tiers.
 *
 * This registry is the coordination point with #1766: that
 * slice extends THIS table list (snapshot export, orphan
 * sweep, purge-run audit live there), it does not build a
 * second retention pass. #1765 contributes the privacy
 * tables (screener_runs, research_runs) to the shared
 * registry; their enforcement rides the existing nightly
 * maintenance path, not a new cron.
 */
export const PRIVACY_RETENTION_TABLES = ["mas_messages", "screener_runs", "research_runs"] as const;

const RETENTION_RULES: Record<string, RetentionRule> = {
  mas_messages: {
    table: "mas_messages",
    maxAgeDays: 30,
    reason: "issue #255 nightly pass: chat history older than 30 days",
  },
  screener_runs: {
    table: "screener_runs",
    maxAgeDays: 30,
    reason: "F-41/PRV-006: screener runs grow unbounded without a bound",
  },
  research_runs: {
    table: "research_runs",
    maxAgeDays: 30,
    reason: "F-41/PRV-006: research runs grow unbounded without a bound",
  },
};

export function retentionRuleFor(table: string): RetentionRule | undefined {
  return RETENTION_RULES[table];
}

export function retentionRules(): RetentionRule[] {
  return PRIVACY_RETENTION_TABLES.map((table) => RETENTION_RULES[table]);
}
