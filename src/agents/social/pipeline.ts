/**
 * #1224 — the social daily pipeline (pipeline:social-daily).
 *
 * One scheduled goal whose executor runs ordered stages back-to-back
 * in a single firing, reusing the generic pipeline executor
 * (src/agents/pipeline.ts) and the existing social machinery:
 *
 *   social.feed → social.generate → social.deliver
 *
 * - social.feed reads the firing date's brief from the brief store
 *   ONLY (human/NLQ-supplied). No brief → the stage skips with
 *   detail noBrief and the run ends skipped: no drafts, no deliver
 *   attempt, nothing invented. This deliberately differs from the
 *   single-operation social.publish executor, whose catch-up sweep
 *   still runs on a noBrief firing: in the pipeline, catch-up lives
 *   inside the deliver stage, which a skipped feed never reaches.
 * - social.generate is buildDailyDrafts, unchanged: posting kill
 *   switch → skipped (postingDisabled); no brief reaching it (cannot
 *   happen after feed, guarded anyway) → skipped; zero drafts
 *   (every channel errored, e.g. unknown channels) → skipped.
 *   Drafts are idempotent per date+channel, so a resumed generate
 *   never duplicates.
 * - social.deliver is publishDueDrafts for the firing date + the
 *   7-prior-date catch-up sweep + the Slack approval-card delivery
 *   pass, with ALL existing gates byte-identical: it calls the same
 *   functions the social.publish path calls, so posting kill switch,
 *   live flag, token presence, approval standing, dry-run-posted
 *   semantics, and live-without-transport-fails-honestly
 *   ("no transport provided for live publish") behave exactly as
 *   they do today. Per-channel publish errors and per-record
 *   delivery errors are collected into the run's errors (for the
 *   caller to record as tick errors) and do NOT fail the stage —
 *   mirroring executeSocialGoal, where publish errors are recorded
 *   but do not unfire the run. The stage fails only on a throw
 *   (e.g. a store transport failure), so a re-fire resumes at
 *   deliver and retries it idempotently (posted drafts skipped,
 *   delivered cards skipped).
 *
 * Store is the durable seam each stage reads/writes, plus the
 * pipeline-run ledger (stage → completed/skipped/failed) in the
 * same SessionStore "social" namespace (get/put only, JSON values;
 * a corrupt ledger value reads as absent, never as a minted run —
 * re-running stages is idempotent, so the next firing self-heals).
 * Serve is NOT a stage: the routes/dashboard stay the always-on
 * surface over these stores.
 *
 * The existing daily-social-post goal (social.publish) is NOT
 * rewired: the pipeline is opt-in via a new goal through the
 * dashboard API (addGoal accepts pipeline:social-daily via the
 * catalog). Automated digest feed (research/screener digest →
 * brief) is OUT OF SCOPE: feed v1 reads the brief store only.
 */

import { buildDailyDrafts, publishDueDrafts } from "../socialAgent";
import { deliverPendingApprovals, fetchSlackPost, type SlackPostFn } from "./delivery";
import { priorDates } from "./goalExecutor";
import { zonedDateParts } from "../../schedule";
import type { SocialLedger } from "./ledger";
import type { PendingApprovalStore } from "./approvals";
import type { SocialBriefStore } from "./briefStore";
import type { SocialEnv } from "./config";
import type { DryRunSink, SocialTransport } from "./publisher";
import {
  createSessionStorePendingApprovalStore,
  createSessionStoreSocialLedger,
  socialStoreOp,
  type SessionStoreStub,
} from "./durableStores";
import { createSessionStoreSocialBriefStore } from "./briefStore";
import type { DoNamespaceLike } from "../../data/durableKv";
import {
  executePipeline,
  type PipelineLedger,
  type PipelineRunRecord,
  type PipelineRunResult,
  type PipelineStageFn,
} from "../pipeline";

export const SOCIAL_DAILY_PIPELINE_ID = "pipeline:social-daily";
export const SOCIAL_DAILY_PIPELINE_STAGES = ["social.feed", "social.generate", "social.deliver"] as const;

export function pipelineRunKey(pipelineId: string, date: string): string {
  return `${pipelineId}:${date}`;
}

function pipelineLedgerKey(runKey: string): string {
  return `social-pipeline-run:${runKey}`;
}

function isPipelineRunRecord(value: unknown): value is PipelineRunRecord {
  if (typeof value !== "object" || value === null) return false;
  const r = value as PipelineRunRecord;
  if (
    typeof r.pipelineId !== "string" ||
    typeof r.runKey !== "string" ||
    typeof r.date !== "string" ||
    (r.status !== "completed" && r.status !== "skipped" && r.status !== "failed") ||
    typeof r.stages !== "object" ||
    r.stages === null
  ) {
    return false;
  }
  if (r.brief !== undefined && typeof r.brief !== "string") return false;
  return Object.values(r.stages).every(
    (s) => s === "completed" || s === "skipped" || s === "failed",
  );
}

/**
 * SessionStore-backed pipeline ledger, following the durableStores
 * pattern exactly: get/put only over the "social" namespace. A
 * corrupt value reads as absent (never a minted run); a transport
 * failure throws, so the caller records the error and leaves the
 * goal due instead of running blind.
 */
export function createSessionStorePipelineLedger(stub: SessionStoreStub): PipelineLedger {
  return {
    async getRun(runKey: string) {
      const reply = await socialStoreOp(stub, "get", pipelineLedgerKey(runKey));
      if (typeof reply.value !== "string") return null;
      try {
        const parsed: unknown = JSON.parse(reply.value);
        return isPipelineRunRecord(parsed) ? parsed : null;
      } catch {
        return null;
      }
    },
    async putRun(record: PipelineRunRecord) {
      await socialStoreOp(stub, "put", pipelineLedgerKey(record.runKey), JSON.stringify(record));
    },
  };
}

/**
 * Resolve all durable social pipeline stores from a Worker Env
 * namespace. Returns null when the namespace is absent, so callers
 * fail closed instead of silently writing to nowhere. Same "kv"
 * instance and "social" namespace as the draft/approval/brief stores.
 */
export function createSocialPipelineStoresFromNamespace(
  namespace: DoNamespaceLike | null | undefined,
): {
  store: SocialLedger;
  approvals: PendingApprovalStore;
  briefStore: SocialBriefStore;
  ledger: PipelineLedger;
} | null {
  if (!namespace) return null;
  const stub = namespace.get(namespace.idFromName("kv")) as SessionStoreStub;
  return {
    store: createSessionStoreSocialLedger(stub),
    approvals: createSessionStorePendingApprovalStore(stub),
    briefStore: createSessionStoreSocialBriefStore(stub),
    ledger: createSessionStorePipelineLedger(stub),
  };
}

export interface SocialPipelineDeps {
  env: SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string };
  /** Token/account values keyed by env var name (e.g. X_ACCESS_TOKEN). */
  tokens: Record<string, string | undefined>;
  store: SocialLedger;
  approvals: PendingApprovalStore;
  briefStore: SocialBriefStore;
  ledger: PipelineLedger;
  nowMs: number;
  /** IANA zone for the firing date; defaults to America/New_York. */
  timeZone?: string;
  transport?: SocialTransport;
  dryRunSink: DryRunSink;
  /** Injected Slack poster (tests). Production uses fetch. */
  slackPost?: SlackPostFn;
  /** Raw env record for Slack destination resolution (webhook/bot token/channel). */
  slackEnv?: {
    SLACK_WEBHOOK_URL?: string;
    SLACK_BOT_TOKEN?: string;
    SOCIAL_SLACK_CHANNEL?: string;
    SLACK_CHANNEL_ID?: string;
    SLACK_CHANNEL?: string;
  };
}

export function createSocialPipelineStages(deps: SocialPipelineDeps): Record<string, PipelineStageFn> {
  const feed: PipelineStageFn = async (ctx) => {
    const brief = await deps.briefStore.getBrief(ctx.date);
    if (!brief || brief.trim() === "") {
      return { status: "skipped", detail: "noBrief" };
    }
    ctx.brief = brief;
    return { status: "completed", detail: "brief present" };
  };

  const generate: PipelineStageFn = async (ctx) => {
    const build = await buildDailyDrafts({
      env: deps.env,
      brief: ctx.brief ?? "",
      nowMs: deps.nowMs,
      store: deps.store,
      timeZone: deps.timeZone,
    });
    if (build.status === "postingDisabled") return { status: "skipped", detail: "postingDisabled" };
    if (build.status === "noBrief") return { status: "skipped", detail: "noBrief" };
    if (!build.channels.some((c) => c.draft !== null)) {
      return { status: "skipped", detail: "noDrafts" };
    }
    return { status: "completed", detail: `drafts for ${build.date}` };
  };

  const deliver: PipelineStageFn = async (ctx) => {
    const errors: string[] = [];
    const date = ctx.date;
    const publish = await publishDueDrafts({
      env: deps.env,
      tokens: deps.tokens,
      store: deps.store,
      approvals: deps.approvals,
      date,
      transport: deps.transport,
      dryRunSink: deps.dryRunSink,
      nowMs: deps.nowMs,
    });
    if (publish.status === "postingDisabled") {
      return { status: "skipped", detail: "postingDisabled" };
    }
    for (const r of publish.results) {
      if (r.outcome === "error") errors.push(`${r.channel}: ${r.reason ?? "publish error"}`);
    }
    for (const prior of priorDates(date)) {
      const swept = await publishDueDrafts({
        env: deps.env,
        tokens: deps.tokens,
        store: deps.store,
        approvals: deps.approvals,
        date: prior,
        transport: deps.transport,
        dryRunSink: deps.dryRunSink,
        nowMs: deps.nowMs,
      });
      if (swept.status === "postingDisabled") break;
      for (const r of swept.results) {
        if (r.outcome === "error") errors.push(`catch-up ${prior} ${r.channel}: ${r.reason ?? "publish error"}`);
      }
    }
    // Slack approval-card delivery pass, mirroring the social.publish
    // branch in scheduled-agent.ts: only when a Slack destination is
    // configured at all; a configured destination that fails records
    // errors (the next pass retries — delivery is idempotent via
    // deliveredDraftId).
    const slackConfigured = deps.slackEnv?.SLACK_WEBHOOK_URL || deps.slackEnv?.SLACK_BOT_TOKEN;
    if (slackConfigured) {
      const deliveries = await deliverPendingApprovals({
        store: deps.store,
        approvals: deps.approvals,
        dates: [date, ...priorDates(date)],
        post: deps.slackPost ?? fetchSlackPost,
        env: deps.slackEnv ?? {},
      });
      for (const d of deliveries) {
        if (d.error) errors.push(`slack delivery ${d.channel} ${d.date}: ${d.error}`);
      }
    }
    return { status: "completed", errors, detail: `delivered for ${date}` };
  };

  return { "social.feed": feed, "social.generate": generate, "social.deliver": deliver };
}

export async function runSocialDailyPipeline(deps: SocialPipelineDeps): Promise<PipelineRunResult> {
  const date = zonedDateParts(deps.nowMs, deps.timeZone ?? "America/New_York").date;
  return executePipeline({
    pipelineId: SOCIAL_DAILY_PIPELINE_ID,
    runKey: pipelineRunKey(SOCIAL_DAILY_PIPELINE_ID, date),
    date,
    stages: [...SOCIAL_DAILY_PIPELINE_STAGES],
    stageFns: createSocialPipelineStages(deps),
    ledger: deps.ledger,
    context: { date },
  });
}
