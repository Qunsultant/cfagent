/**
 * #1077 Phase 4 + Phase 5a — SocialMediaAgent.
 *
 * Phase 4 (drafts-only skeleton):
 * - buildDailyDrafts composes and stores drafts, then stops.
 * - publishDraft refuses every attempt with not_implemented_phase5.
 *   It stays as the Phase 4 placeholder; publishDueDrafts below is
 *   the Phase 5a path and does not call it.
 *
 * Phase 5a (token-independent publish gating):
 * - publishDueDrafts publishes the drafts that are DUE for a date:
 *   approval-list drafts only when status is "approved" — or when
 *   status is "dry-run-posted" WITH its approval record (an approved
 *   draft keeps its approval standing through a dry-run publish,
 *   #1171); autonomous drafts when status is "draft", "approved",
 *   or "dry-run-posted" (approval never blocks an autonomous
 *   channel). Posted/failed drafts are never republished.
 * - Publication resolves per channel through publisher.ts: dry-run by
 *   default; live only when posting is on, SOCIAL_LIVE_PUBLISHING is
 *   "1"/"true", and the channel token (and account id, where
 *   required) is present. A failed live gate is an error entry, never
 *   a silent dry-run fallback.
 * - Per-channel failures are error entries, never throws, never
 *   blocking other channels. A failed publish attempt leaves the draft
 *   in its pre-publish status for a later retry — it is NOT marked
 *   failed (only an explicit rejectDraft does that).
 * - "posted" means REALLY posted (#1171): a dry-run publish sets
 *   status "dry-run-posted" and records nothing on the draft, so
 *   flipping live mid-day still live-publishes that day's drafts;
 *   a live publish sets status "posted" and records the platform
 *   post id on the draft. A dry-run sweep skips already
 *   dry-run-posted drafts (no double sink record). The result
 *   outcome vocabulary ("posted" for a publish this sweep made) is
 *   unchanged, so goal fired/catch-up accounting is unaffected.
 *
 * Hard rules (unchanged from Phase 4):
 * - Posting disabled (SOCIAL_POSTING_ENABLED off) → early return
 *   "postingDisabled"; nothing is written.
 * - No brief (missing, empty, or whitespace-only) → early return
 *   "noBrief"; nothing is written. The agent NEVER invents placeholder
 *   content: without a brief there are no drafts, full stop.
 * - One draft per enabled channel (autonomous list + approval list),
 *   written idempotently: a second build the same day returns the first
 *   draft set, never duplicates.
 * - Channel disposition follows the fail-closed resolution in
 *   social/config.ts (both lists → approval; unknown → approval).
 * - Unknown configured channels produce an error entry, never a draft,
 *   and never throw.
 */

import {
  parseSocialConfig,
  enabledChannels,
  resolveChannelDisposition,
  KNOWN_SOCIAL_CHANNELS,
  type SocialEnv,
} from "./social/config";
import { createDraft, type SocialDraft } from "./social/draft";
import { getOrCreateDraft, type SocialLedger } from "./social/ledger";
import { zonedDateParts } from "../schedule";
import { resolveEnvironmentConfig } from "../config/environment";
import type { Env } from "../types";
import type { PendingApprovalStore } from "./social/approvals";
import {
  resolvePublishTarget,
  publishWithPublisher,
  type DryRunSink,
  type PublishEnv,
  type SocialTransport,
} from "./social/publisher";

export type BuildStatus = "postingDisabled" | "noBrief" | "drafts";

export interface ChannelBuildResult {
  channel: string;
  disposition: "autonomous" | "approval";
  draft: SocialDraft | null;
  error?: string;
}

export interface DailyDraftsResult {
  status: BuildStatus;
  date: string | null;
  channels: ChannelBuildResult[];
}

export async function buildDailyDrafts(input: {
  env: SocialEnv;
  brief: string;
  nowMs: number;
  store: SocialLedger;
  /**
   * IANA zone the draft date is read in. Defaults to America/New_York
   * (the Phase 4/5a behavior); the social goal executor passes the
   * goal's timeZone here.
   */
  timeZone?: string;
}): Promise<DailyDraftsResult> {
  const config = parseSocialConfig(input.env);
  if (!config.postingEnabled) {
    return { status: "postingDisabled", date: null, channels: [] };
  }
  if (!input.brief || input.brief.trim() === "") {
    return { status: "noBrief", date: null, channels: [] };
  }

  const date = zonedDateParts(input.nowMs, input.timeZone ?? "America/New_York").date;
  const channels: ChannelBuildResult[] = [];
  for (const channel of enabledChannels(config)) {
    const disposition = resolveChannelDisposition(channel, config);
    const created = createDraft({
      channel,
      text: input.brief,
      date,
      createdAtMs: input.nowMs,
    });
    if (!created.ok) {
      channels.push({ channel, disposition, draft: null, error: created.error });
      continue;
    }
    const draft = await getOrCreateDraft(input.store, date, channel, () => created.draft);
    channels.push({ channel, disposition, draft });
  }
  return { status: "drafts", date, channels };
}

export interface ChannelPublishResult {
  channel: string;
  disposition: "autonomous" | "approval";
  draftId: string | null;
  outcome: "posted" | "skipped" | "error";
  platformPostId?: string;
  reason?: string;
}

export interface PublishDueResult {
  date: string;
  status: "postingDisabled" | "done";
  results: ChannelPublishResult[];
}

/**
 * Publish the drafts that are DUE for a date (see the module
 * docstring for the gating rules). Async because live publishes use
 * the injected transport. Never throws: every per-channel outcome —
 * including transport failures and unknown channels — is a result
 * entry, so one channel can never take down the batch.
 */
export async function publishDueDrafts(input: {
  env: SocialEnv & { SOCIAL_LIVE_PUBLISHING?: string };
  tokens: Record<string, string | undefined>;
  store: SocialLedger;
  approvals: PendingApprovalStore;
  date: string;
  transport?: SocialTransport;
  dryRunSink: DryRunSink;
  nowMs: number;
}): Promise<PublishDueResult> {
  const config = parseSocialConfig(input.env);
  if (!config.postingEnabled) {
    return { date: input.date, status: "postingDisabled", results: [] };
  }
  // Phase 3 (#6550): the two flags resolve from
  // environment.config.json (defaults.social); a still-set env var
  // wins. Rendered back as "1"/"0" strings for the publisher gate.
  const resolvedSocial = resolveEnvironmentConfig(
    input.env as Partial<Env> | undefined,
  ).workerSettings.social;
  const publishEnv: PublishEnv = {
    SOCIAL_POSTING_ENABLED: resolvedSocial.postingEnabled ? "1" : "0",
    SOCIAL_LIVE_PUBLISHING: resolvedSocial.livePublishing ? "1" : "0",
  };
  const results: ChannelPublishResult[] = [];
  for (const draft of await input.store.listDrafts(input.date)) {
    const channel = draft.channel;
    try {
      if (!(KNOWN_SOCIAL_CHANNELS as readonly string[]).includes(channel)) {
        results.push({
          channel,
          disposition: "approval",
          draftId: draft.id,
          outcome: "error",
          reason: `unknown social channel: ${channel}`,
        });
        continue;
      }
      const disposition = resolveChannelDisposition(channel, config);
      if (draft.status === "posted" || draft.status === "failed") {
        results.push({
          channel,
          disposition,
          draftId: draft.id,
          outcome: "skipped",
          reason: `draft already ${draft.status}`,
        });
        continue;
      }
      // #1171: an approved draft keeps its approval standing
      // through a dry-run publish — a dry-run-posted draft WITH its
      // approval record is still publishable. A dry-run-posted
      // draft WITHOUT a record cannot occur through the normal
      // flow (dry-run requires approval first); it fails closed
      // here as awaiting approval rather than publishing.
      if (
        disposition === "approval" &&
        !(draft.status === "approved" || (draft.status === "dry-run-posted" && draft.approval))
      ) {
        // Record the request; delivery (Slack approval card) is Phase 5b.
        // Slice 3: re-recording must not wipe the delivery mark — the
        // pending request is the same one while the draftId is
        // unchanged, so a delivered card stays delivered across
        // sweeps (otherwise every catch-up sweep would re-deliver).
        const existing = (await input.approvals.listPending(input.date)).find(
          (p) => p.channel === channel,
        );
        await input.approvals.recordPending({
          date: input.date,
          channel,
          draftId: draft.id,
          requestedAtMs: input.nowMs,
          ...(existing && existing.draftId === draft.id && existing.deliveredDraftId
            ? { deliveredDraftId: existing.deliveredDraftId }
            : {}),
        });
        results.push({
          channel,
          disposition,
          draftId: draft.id,
          outcome: "skipped",
          reason: "awaiting approval",
        });
        continue;
      }
      const target = resolvePublishTarget(channel, {
        env: publishEnv,
        tokens: input.tokens,
        dryRunSink: input.dryRunSink,
      });
      if (target.kind === "unavailable") {
        results.push({
          channel,
          disposition,
          draftId: draft.id,
          outcome: "error",
          reason: target.error,
        });
        continue;
      }
      // #1171: a dry-run sweep skips drafts it already dry-run-posted
      // (no double sink record). A live sweep does NOT skip them —
      // that is the mid-day flip: they are published for real now.
      // This check sits after the approval gate on purpose, so an
      // unapproved draft still reports "awaiting approval" rather
      // than a dry-run skip, exactly as before.
      if (target.kind === "dry-run" && draft.status === "dry-run-posted") {
        results.push({
          channel,
          disposition,
          draftId: draft.id,
          outcome: "skipped",
          reason: "draft already dry-run posted",
        });
        continue;
      }
      const published =
        target.kind === "dry-run"
          ? target.publisher.publish(draft, input.nowMs)
          : input.transport
            ? await publishWithPublisher(target.def, {
                token: input.tokens[target.def.tokenEnvVar],
                accountId: target.def.accountEnvVar
                  ? input.tokens[target.def.accountEnvVar]
                  : undefined,
                text: draft.text,
                transport: input.transport,
              })
            : { ok: false as const, error: "no transport provided for live publish" };
      if (!published.ok) {
        results.push({
          channel,
          disposition,
          draftId: draft.id,
          outcome: "error",
          reason: published.error,
        });
        continue;
      }
      // #1171: only a live publish earns "posted" — and only a live
      // publish records the platform post id on the draft. A dry-run
      // publish records "dry-run-posted" and no id, so a later live
      // sweep still publishes it. The result outcome ("posted") is
      // unchanged for both, so goal fired/catch-up accounting — which
      // counts outcomes, not draft statuses — behaves as before.
      if (target.kind === "dry-run") {
        await input.store.putDraft({ ...draft, status: "dry-run-posted" });
      } else {
        await input.store.putDraft({
          ...draft,
          status: "posted",
          platformPostId: published.platformPostId,
        });
      }
      await input.approvals.clearPending(input.date, channel);
      results.push({
        channel,
        disposition,
        draftId: draft.id,
        outcome: "posted",
        platformPostId: published.platformPostId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      results.push({
        channel,
        disposition: "approval",
        draftId: draft.id,
        outcome: "error",
        reason: `unexpected publish failure: ${message}`,
      });
    }
  }
  return { date: input.date, status: "done", results };
}

/**
 * Phase 4 placeholder, kept for API compatibility. Every direct
 * publish attempt through this function refuses with
 * not_implemented_phase5. Phase 5a publishing goes through
 * publishDueDrafts above, never through this function.
 */
export function publishDraft(_input: {
  channel: string;
  draftId: string;
}): { ok: false; error: "not_implemented_phase5" } {
  return { ok: false, error: "not_implemented_phase5" };
}
