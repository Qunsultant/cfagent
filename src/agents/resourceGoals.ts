/**
 * ScheduledAgent goal handlers for #1819 resource measurement.
 *
 * These are the executors behind the `resource.*` operations in the
 * orchestrator catalog: ScheduledAgent's onCron branches call them
 * directly (the social.publish precedent), never through createJob —
 * createJob mints a pending descriptor and executes nothing.
 *
 * Data source: the D1 projection (`resource_sql_ops`, written by the
 * fan-out port). There is no in-Worker Analytics Engine read path, so
 * the AE stream is the transport and D1 is the queryable projection;
 * this module never invents a second pipeline, it only reads the one
 * the measurement slice already writes.
 *
 * Failure semantics (match the onCron branch conventions):
 * - A thrown error means the goal stays due and retries on a later
 *   matching tick; the branch records it as a tick error.
 * - The cap-alert handler never throws for delivery problems: attempted
 *   deliveries that fail are returned as `undelivered` (state unmarked,
 *   so the next matching tick retries), while a missing Slack
 *   destination is returned as `noDestination` and marked (so one tick
 *   error per breach-day surfaces the misconfiguration without hourly
 *   spam). The onCron branch decides tick accounting from the result.
 *
 * Alert delivery reuses the EXISTING Slack route from social delivery:
 * webhook (SLACK_WEBHOOK_URL) first, else chat.postMessage via
 * SLACK_BOT_TOKEN + the shared channel resolution — same poster
 * (fetchSlackPost), same destination order, same {ok} judging. The
 * payload is plain text, not a Block Kit approval card: an alert asks
 * for nothing, so it must not carry Approve/Reject buttons.
 */
import { D1ResourceUsageAdapter, type ResourceD1Db } from "../telemetry/d1ResourceUsageAdapter";
import {
  buildComparisonReport,
  buildTierAlertText,
  evaluateCapAlert,
  evaluateCapTiers,
  previousUtcDay,
  rollupRowsFromTotals,
  tierAlertKey,
  utcDayBounds,
  utcDayOf,
  type CapBreach,
  type ComparisonReport,
  type DailyRollupRow,
} from "../telemetry/resourceRollup";
import {
  ensureResourceRollupTables,
  getAlertState,
  latestCompletedRollupDay,
  markAlerted,
  readDailyRollup,
  writeComparisonReport,
  writeDailyRollup,
} from "../telemetry/resourceRollupStore";
import {
  fetchSlackPost,
  resolveSocialSlackChannel,
  type SlackDeliveryEnv,
  type SlackPostFn,
} from "./social/delivery";
import { renderChannelText } from "../outcomes/outcomeAspects";

export type ResourceGoalDb = ResourceD1Db;

const DAY_MS = 86_400_000;

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export interface RollupResult {
  day: string;
  groups: number;
  ops: number;
  rowsRead: number;
  rowsWritten: number;
}

/** Roll the previous UTC day's projection totals into daily rollup rows. */
export async function runResourceRollup(deps: {
  db: ResourceGoalDb;
  nowMs: number;
}): Promise<RollupResult> {
  const day = previousUtcDay(deps.nowMs);
  const { startMs, endMs } = utcDayBounds(day);
  await ensureResourceRollupTables(deps.db);
  const totals = await new D1ResourceUsageAdapter(deps.db).totals(startMs, endMs, DAY_MS);
  const rows = rollupRowsFromTotals(totals, day);
  await writeDailyRollup(deps.db, day, rows);
  const sums = rows.reduce(
    (acc, r) => ({ ops: acc.ops + r.ops, rowsRead: acc.rowsRead + r.rowsRead, rowsWritten: acc.rowsWritten + r.rowsWritten }),
    { ops: 0, rowsRead: 0, rowsWritten: 0 }
  );
  return { day, groups: rows.length, ...sums };
}

export type SlackTextResult =
  | { ok: true; method: "webhook" | "bot" }
  | { ok: false; error: string; noDestination?: boolean };

/**
 * Post plain text through the existing Slack route (webhook, else bot).
 * Mirrors deliverApprovalCard's destination order; judges the bot reply
 * by Slack's {ok} field, not just the HTTP status. Returns noDestination
 * ONLY when neither a webhook nor a bot token is configured at all — a
 * configured destination that fails is a failure, not a missing config.
 */
export async function postSlackText(deps: {
  post: SlackPostFn;
  env: SlackDeliveryEnv;
  text: string;
}): Promise<SlackTextResult> {
  const webhookUrl = deps.env.SLACK_WEBHOOK_URL;
  let webhookError: string | undefined;
  if (webhookUrl) {
    try {
      const res = await deps.post(
        webhookUrl,
        { "Content-Type": "application/json; charset=utf-8" },
        JSON.stringify({ text: deps.text })
      );
      if (res.status >= 200 && res.status < 300) return { ok: true, method: "webhook" };
      webhookError = `Slack webhook delivery failed: HTTP ${res.status}`;
    } catch (err) {
      webhookError = `Slack webhook delivery failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
  const token = deps.env.SLACK_BOT_TOKEN;
  const channel = resolveSocialSlackChannel(deps.env);
  if (!token) {
    return {
      ok: false,
      error: webhookError ?? "No Slack webhook URL or bot token is configured for delivery",
      noDestination: webhookUrl ? undefined : true,
    };
  }
  if (!channel) {
    return {
      ok: false,
      error: "No Slack channel is configured for delivery (set SOCIAL_SLACK_CHANNEL or SLACK_CHANNEL)",
    };
  }
  try {
    const res = await deps.post(
      "https://slack.com/api/chat.postMessage",
      { Authorization: `Bearer ${token}`, "Content-Type": "application/json; charset=utf-8" },
      JSON.stringify({ channel, text: deps.text })
    );
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `Slack chat.postMessage failed: HTTP ${res.status}` };
    }
    let data: { ok?: boolean; error?: string } = {};
    try {
      data = JSON.parse(res.body) as { ok?: boolean; error?: string };
    } catch {
      return { ok: false, error: "Slack chat.postMessage returned an unreadable response" };
    }
    if (data.ok) return { ok: true, method: "bot" };
    return { ok: false, error: `Slack chat.postMessage failed: ${data.error ?? "unknown error"}` };
  } catch (err) {
    return {
      ok: false,
      error: `Slack chat.postMessage failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function buildAlertText(
  day: string,
  cumulative: { rowsRead: number; rowsWritten: number; ops: number },
  breaches: Array<{ budget: string; cumulative: number; limit: number; pct: number }>
): string {
  const breachLines = breaches
    .map((b) =>
      renderChannelText("resource_cap_breach_line", "slack", {
        budget: b.budget,
        cumulative: fmt(b.cumulative),
        limit: fmt(b.limit),
        pct: (b.pct * 100).toFixed(1),
      }, "legacy_resource_cap_breach_line"),
    )
    .join("\n");
  return renderChannelText("resource_cap_alert", "slack", {
    day,
    breachLines,
    rowsRead: fmt(cumulative.rowsRead),
    rowsWritten: fmt(cumulative.rowsWritten),
    ops: fmt(cumulative.ops),
  }, "legacy_resource_cap_alert");
}

export interface CapAlertResult {
  day: string;
  cumulative: { rowsRead: number; rowsWritten: number; ops: number };
  breaches: string[];
  alerted: string[];
  undelivered: Array<{ budget: string; error: string }>;
  noDestination: Array<{ budget: string }>;
  /** #2840: budgets at the 90%/100% tiers this evaluation (tier keys, e.g. "rowsRead:90"). */
  tierBreaches: string[];
  /** #2840: tier keys actually posted by this evaluation. */
  tierAlerted: string[];
  /** #2840: tier keys that failed delivery (unmarked, so the next tick retries). */
  tierUndelivered: Array<{ budget: string; error: string }>;
  /** #2840: tier keys with no Slack destination (marked, one tick error per tier-day). */
  tierNoDestination: Array<{ budget: string }>;
}

/**
 * Evaluate the current UTC day-to-date against the 70% thresholds.
 * Delivery is deduped by alert state per (budget, day): an already-alerted
 * budget is never re-posted, which is what makes the twice-per-hour
 * evaluation (see the onCron branch note) safe.
 *
 * #2840: the same evaluation then applies the 90% (escalate) and
 * 100% (critical) tiers. Tier delivery dedups per (tier key, day)
 * — the tier key suffixes the tier, so a 90% alert is never
 * swallowed by the day's already-marked 70% alert for the same
 * budget, and never re-posts for its own tier-day. The 70%
 * behavior above is unchanged.
 */
export async function runResourceCapAlert(deps: {
  db: ResourceGoalDb;
  nowMs: number;
  post: SlackPostFn;
  env: SlackDeliveryEnv;
}): Promise<CapAlertResult> {
  const day = utcDayOf(deps.nowMs);
  const { startMs } = utcDayBounds(day);
  await ensureResourceRollupTables(deps.db);
  const totals = await new D1ResourceUsageAdapter(deps.db).totals(startMs, deps.nowMs, DAY_MS);
  const cumulative = totals.reduce(
    (acc, t) => ({ rowsRead: acc.rowsRead + t.rowsRead, rowsWritten: acc.rowsWritten + t.rowsWritten, ops: acc.ops + t.ops }),
    { rowsRead: 0, rowsWritten: 0, ops: 0 }
  );
  const { breaches } = evaluateCapAlert(cumulative);
  const alerted: string[] = [];
  const undelivered: Array<{ budget: string; error: string }> = [];
  const noDestination: Array<{ budget: string }> = [];
  if (breaches.length > 0) {
    const text = buildAlertText(day, cumulative, breaches);
    for (const breach of breaches) {
      const existing = await getAlertState(deps.db, breach.budget, day);
      if (existing) continue;
      const res = await postSlackText({ post: deps.post, env: deps.env, text });
      if (res.ok) {
        await markAlerted(deps.db, breach.budget, day, true, `delivered via ${res.method}`);
        alerted.push(breach.budget);
      } else if (res.noDestination) {
        await markAlerted(deps.db, breach.budget, day, false, res.error);
        noDestination.push({ budget: breach.budget });
      } else {
        undelivered.push({ budget: breach.budget, error: res.error });
      }
    }
  }
  // #2840: 90% escalate + 100% critical tiers. Each tier posts
  // its own text (the watch text above never names the tier
  // action), deduped per tier key + day. A budget already at
  // critical posts only the critical text, not both tiers —
  // the critical text subsumes the escalation.
  const tiers = evaluateCapTiers(cumulative);
  const tierBreaches: string[] = [];
  const tierAlerted: string[] = [];
  const tierUndelivered: Array<{ budget: string; error: string }> = [];
  const tierNoDestination: Array<{ budget: string }> = [];
  const breachByBudget = new Map<string, CapBreach>(breaches.map((b) => [b.budget, b]));
  for (const assessment of [tiers.rowsRead, tiers.rowsWritten, tiers.doRequests]) {
    if (assessment.tier !== "escalate" && assessment.tier !== "critical") continue;
    const key = tierAlertKey(assessment.budget, assessment.tier, day);
    tierBreaches.push(key);
    const existing = await getAlertState(deps.db, key, day);
    if (existing) continue;
    // The breach row for the tier text: the 70% breach row when
    // present (same budget, same cumulative), else a tier-built row.
    const breach: CapBreach = breachByBudget.get(assessment.budget) ?? {
      budget: assessment.budget,
      cumulative: assessment.cumulative,
      limit: assessment.limit,
      pct: assessment.pct,
    };
    const text = buildTierAlertText(day, assessment.tier, [breach]);
    const res = await postSlackText({ post: deps.post, env: deps.env, text });
    if (res.ok) {
      await markAlerted(deps.db, key, day, true, `delivered via ${res.method}`);
      tierAlerted.push(key);
    } else if (res.noDestination) {
      await markAlerted(deps.db, key, day, false, res.error);
      tierNoDestination.push({ budget: key });
    } else {
      tierUndelivered.push({ budget: key, error: res.error });
    }
  }
  return {
    day,
    cumulative,
    breaches: breaches.map((b) => b.budget),
    alerted,
    undelivered,
    noDestination,
    tierBreaches,
    tierAlerted,
    tierUndelivered,
    tierNoDestination,
  };
}

export type ComparisonResult = ComparisonReport | { skipped: string };

/**
 * Build the comparison report for the LATEST COMPLETED rollup day — not
 * the wall-clock day. That is what makes a forced evaluation reproduce
 * the scheduled run exactly: both read the same rollup rows and format
 * the same report JSON, whenever they run.
 */
export async function runResourceComparison(deps: {
  db: ResourceGoalDb;
}): Promise<ComparisonResult> {
  await ensureResourceRollupTables(deps.db);
  const day = await latestCompletedRollupDay(deps.db);
  if (!day) return { skipped: "no completed rollup yet" };
  const rows: DailyRollupRow[] = await readDailyRollup(deps.db, day);
  const report = buildComparisonReport({ day, rows });
  await writeComparisonReport(deps.db, day, report);
  return report;
}

/** Production poster (fetch) for handlers called outside onCron tests. */
export const resourceSlackPost: SlackPostFn = fetchSlackPost;
