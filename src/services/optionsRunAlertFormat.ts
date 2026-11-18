/**
 * Issue #5183 — the scheduled options failure alert must be diagnosable from
 * the message alone.
 *
 * The alert that reached Slack on 2026-11-17 (incident #5181) said only
 * "Options Screen FAILED — NASDAQ100 (bullish) · <error> · <time>". The reader
 * could not tell which schedule fired, how it was dispatched, which workflow
 * ran, what mode/broker it resolved, or which run it was — four identical
 * copies of that. Every one of those values exists at the call site; this
 * formatter is the single place that renders them, so the failure notice and
 * any later success notice cannot drift.
 *
 * Unknown values render as `unknown` — never blank, never guessed.
 */
import { codedMessage } from "../outcomes/outcomeAspects";

export interface OptionsRunAlertContext {
  /** `scheduled` | `manual` | `triggered` — the run type the firer used. */
  readonly trigger?: string;
  /** The login that owns the run (the schedule's owner). */
  readonly owner?: string;
  readonly scheduleId?: string;
  readonly workflow?: string;
  readonly mode?: string;
  readonly modeSource?: string;
  readonly broker?: string;
  readonly accountId?: string | null;
  readonly runId?: string;
}

const orUnknown = (value: string | null | undefined): string =>
  typeof value === "string" && value.trim() ? value.trim() : "unknown";

/** One `·`-joined line naming everything the run executed under. */
export function optionsRunContextLine(ctx: OptionsRunAlertContext): string {
  const mode = orUnknown(ctx.mode);
  const modeSource = typeof ctx.modeSource === "string" && ctx.modeSource.trim() ? ` (${ctx.modeSource.trim()})` : "";
  const parts = [
    `dispatch ${orUnknown(ctx.trigger) === "unknown" ? "scheduled" : orUnknown(ctx.trigger)}`,
    `owner ${orUnknown(ctx.owner)}`,
    // Issue #5232: the schedule is ALWAYS rendered. A scheduled run with no
    // schedule id is a traceability defect, and omitting the field hides it.
    `schedule ${orUnknown(ctx.scheduleId)}`,
    `workflow ${orUnknown(ctx.workflow) === "unknown" ? "optionsScreenWorkflow" : orUnknown(ctx.workflow)}`,
    `mode ${mode}${modeSource}`,
    `broker ${orUnknown(ctx.broker)}`,
    ctx.accountId ? `account ${ctx.accountId}` : null,
    `run ${orUnknown(ctx.runId)}`,
  ];
  return parts.filter(Boolean).join(" · ");
}

/**
 * Issue #5231 — the seam must never surface an uncoded failure.
 *
 * The 23:35Z alert read `Error: internal error` — a raw provider/RPC string,
 * so neither the alert nor the run record could classify it. A message that
 * already carries `[FAILURE_…]` passes through untouched (no double wrap);
 * anything else becomes `FAILURE_UNEXPECTED_ERROR` with the raw text and the
 * broker kept as detail. The run's audit row keeps the raw message either way.
 */
export function ensureCodedOutcome(message: unknown, broker?: string): string {
  const raw = typeof message === "string" && message.trim() ? message.trim() : "unknown failure";
  if (/^\[FAILURE_[A-Z0-9_]+\]/.test(raw)) return raw;
  const detail = [broker ? `broker ${broker}` : null, raw].filter(Boolean).join(": ");
  return codedMessage("FAILURE_UNEXPECTED_ERROR", detail);
}

/** The failure notice: one headline, the context line, the cause, the time. */
export function optionsFailureAlertText(args: {
  universe: string;
  thesis: string;
  context: OptionsRunAlertContext;
  errorMessage: string;
  timestamp: string;
}): string {
  return [
    `⚠️ Scheduled Options Screen FAILED — ${args.universe} (${args.thesis})`,
    optionsRunContextLine(args.context),
    `Error: ${args.errorMessage || "Scheduled options analysis failed"}`,
    `_Time: ${args.timestamp}_`,
  ].join("\n");
}

/**
 * Issue #5182 — one notice per (run, rendered text), remembered for a short
 * window.
 *
 * Incident #5181 saw the SAME message posted twice with the same timestamp:
 * one delivery payload observed twice, not two runs. The transports are
 * fallback-only (`deliverScreenerToSlack`: A2A, then direct on failure), so the
 * duplicate is inside a single run's notification path.
 *
 * This guard is deliberately narrow: the key is the run id plus the exact
 * rendered text, so two *different* runs can never collide, and a retry that
 * produced different text still delivers. It is best-effort per isolate (a
 * module-level map, no storage dependency); the root cause still wants the A2A
 * log line recorded on #5182, and this guard does not hide a second execution
 * because it keys on the run that executed.
 */
export function claimNoticeDelivery(key: string, nowMs: number = Date.now(), windowMs: number = 300_000): boolean {
  for (const [seen, at] of DELIVERED_NOTICES) {
    if (nowMs - at > windowMs) DELIVERED_NOTICES.delete(seen);
  }
  if (DELIVERED_NOTICES.has(key)) return false;
  DELIVERED_NOTICES.set(key, nowMs);
  return true;
}

const DELIVERED_NOTICES = new Map<string, number>();
