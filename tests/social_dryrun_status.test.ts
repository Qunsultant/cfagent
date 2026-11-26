/**
 * Issue #1171: a dry-run publish must NOT mark a draft "posted".
 *
 * Before this fix, publishDueDrafts set status "posted" for dry-run
 * publishes too, so flipping SOCIAL_LIVE_PUBLISHING on mid-day
 * skipped that day's drafts (they already read "posted") even though
 * nothing reached any platform. The fix gives dry-run publishes
 * their own status ("dry-run-posted") and records the platform post
 * id only on a real live post, so "posted" means really-posted:
 * - dry-run publish → "dry-run-posted", no platform post id.
 * - live publish of a dry-run-posted draft → "posted" + platform id,
 *   exactly once; live-posted drafts are never republished.
 * - a dry-run sweep skips already dry-run-posted drafts (no double
 *   sink record); a failed live publish leaves the draft
 *   dry-run-posted (retryable), never "posted" or "failed".
 * - approval standing survives a dry-run publish: an approved draft
 *   that was dry-run-posted still live-publishes without re-approval,
 *   while an unapproved approval draft is still skipped.
 *
 * All live behavior here is proven with injected fake transports
 * only — no test touches a real platform.
 */
import { describe, it, expect } from "vitest";
import { MemorySocialLedger, isSocialDraft } from "../src/agents/social/ledger";
import {
  MemoryPendingApprovalStore,
  approveDraft,
  rejectDraft,
} from "../src/agents/social/approvals";
import { buildDailyDrafts, publishDueDrafts } from "../src/agents/socialAgent";
import { executeSocialGoal } from "../src/agents/social/goalExecutor";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";
import type { SocialDraft } from "../src/agents/social/draft";

const DATE = "2026-10-26";
const MON_0900 = Date.parse("2026-10-26T13:00:00Z");
// Phase 3 (#6550): SOCIAL_AUTONOMOUS_CHANNELS lives in
// environment.config.json ("threads" in production), so a bare env no
// longer resolves the code default ["threads", "x"]. These tests pin
// dry-run publishing of x drafts, so the list is set explicitly here.
const DRY_RUN_ENV = { SOCIAL_POSTING_ENABLED: "1", SOCIAL_AUTONOMOUS_CHANNELS: "threads,x" };
const LIVE_ENV = { SOCIAL_POSTING_ENABLED: "1", SOCIAL_LIVE_PUBLISHING: "1", SOCIAL_AUTONOMOUS_CHANNELS: "threads,x" };

function mkDraft(channel: string, status: SocialDraft["status"]): SocialDraft {
  return {
    id: `draft-${channel}`,
    date: DATE,
    channel: channel as SocialDraft["channel"],
    text: `post for ${channel}`,
    status,
    createdAtMs: 0,
    originalLength: 10,
    truncated: false,
  };
}

function ledgerWith(...drafts: SocialDraft[]) {
  const store = new MemorySocialLedger();
  for (const d of drafts) store.putDraft(d);
  return store;
}

function okTransport(calls: string[]) {
  return {
    post: async (url: string): Promise<{ status: number; body: unknown }> => {
      calls.push(url);
      return { status: 200, body: { id: "platform-123" } };
    },
  };
}

function failingTransport(calls: string[]) {
  return {
    post: async (url: string): Promise<{ status: number; body: unknown }> => {
      calls.push(url);
      return { status: 500, body: {} };
    },
  };
}

async function dryRunSweep(store: MemorySocialLedger, approvals: MemoryPendingApprovalStore) {
  const sink = createMemoryDryRunSink();
  const res = await publishDueDrafts({
    env: DRY_RUN_ENV,
    tokens: {},
    store,
    approvals,
    date: DATE,
    dryRunSink: sink,
    nowMs: MON_0900,
  });
  return { res, sink };
}

describe("dry-run publish status (#1171)", () => {
  it("a dry-run publish marks the draft dry-run-posted, not posted, with no platform post id", async () => {
    const store = ledgerWith(mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const { res, sink } = await dryRunSweep(store, approvals);
    expect(res.results.find((r) => r.channel === "x")?.outcome).toBe("posted");
    expect(sink.records).toHaveLength(1);
    const stored = store.getDraft(DATE, "x");
    expect(stored?.status).toBe("dry-run-posted");
    expect(stored?.platformPostId).toBeUndefined();
  });

  it("a dry-run sweep skips already dry-run-posted drafts (no double sink record)", async () => {
    const store = ledgerWith(mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const first = await dryRunSweep(store, approvals);
    expect(first.sink.records).toHaveLength(1);
    const second = await dryRunSweep(store, approvals);
    expect(second.res.results.find((r) => r.channel === "x")?.outcome).toBe("skipped");
    expect(second.sink.records).toHaveLength(0);
    expect(store.getDraft(DATE, "x")?.status).toBe("dry-run-posted");
  });

  it("flipping live mid-day live-publishes a dry-run-posted draft exactly once, with the platform id recorded", async () => {
    const store = ledgerWith(mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    await dryRunSweep(store, approvals);
    expect(store.getDraft(DATE, "x")?.status).toBe("dry-run-posted");
    const calls: string[] = [];
    const live = await publishDueDrafts({
      env: LIVE_ENV,
      tokens: { X_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport: okTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
      nowMs: MON_0900,
    });
    expect(live.results.find((r) => r.channel === "x")?.outcome).toBe("posted");
    expect(live.results.find((r) => r.channel === "x")?.platformPostId).toBe("platform-123");
    expect(calls).toHaveLength(1);
    const stored = store.getDraft(DATE, "x");
    expect(stored?.status).toBe("posted");
    expect(stored?.platformPostId).toBe("platform-123");
    // A second live sweep never republishes it.
    const again = await publishDueDrafts({
      env: LIVE_ENV,
      tokens: { X_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport: okTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
      nowMs: MON_0900,
    });
    expect(again.results.find((r) => r.channel === "x")?.outcome).toBe("skipped");
    expect(calls).toHaveLength(1);
  });

  it("a failed live publish of a dry-run-posted draft leaves it dry-run-posted (retryable)", async () => {
    const store = ledgerWith(mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    await dryRunSweep(store, approvals);
    const calls: string[] = [];
    const live = await publishDueDrafts({
      env: LIVE_ENV,
      tokens: { X_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport: failingTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
      nowMs: MON_0900,
    });
    expect(live.results.find((r) => r.channel === "x")?.outcome).toBe("error");
    expect(calls).toHaveLength(1);
    expect(store.getDraft(DATE, "x")?.status).toBe("dry-run-posted");
    expect(store.getDraft(DATE, "x")?.platformPostId).toBeUndefined();
  });

  it("an approved draft keeps its approval standing through a dry-run publish and live-publishes without re-approval", async () => {
    const store = ledgerWith(mkDraft("facebook", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const approved = await approveDraft(store, approvals, DATE, "facebook", "owner", 999);
    expect(approved.ok).toBe(true);
    await dryRunSweep(store, approvals);
    const afterDryRun = store.getDraft(DATE, "facebook");
    expect(afterDryRun?.status).toBe("dry-run-posted");
    expect(afterDryRun?.approval).toEqual({ approver: "owner", approvedAtMs: 999 });
    const calls: string[] = [];
    const live = await publishDueDrafts({
      env: LIVE_ENV,
      tokens: { FACEBOOK_PAGE_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport: okTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
      nowMs: MON_0900,
    });
    expect(live.results.find((r) => r.channel === "facebook")?.outcome).toBe("posted");
    expect(calls).toHaveLength(1);
    expect(store.getDraft(DATE, "facebook")?.status).toBe("posted");
    expect(store.getDraft(DATE, "facebook")?.platformPostId).toBe("platform-123");
  });

  it("an unapproved approval draft is still skipped in live mode (approval still required)", async () => {
    const store = ledgerWith(mkDraft("facebook", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    const calls: string[] = [];
    const live = await publishDueDrafts({
      env: LIVE_ENV,
      tokens: { FACEBOOK_PAGE_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport: okTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
      nowMs: MON_0900,
    });
    expect(live.results.find((r) => r.channel === "facebook")?.outcome).toBe("skipped");
    expect(live.results.find((r) => r.channel === "facebook")?.reason).toBe("awaiting approval");
    expect(calls).toHaveLength(0);
    expect(store.getDraft(DATE, "facebook")?.status).toBe("draft");
  });

  it("rejecting a dry-run-posted draft blocks its live publish", async () => {
    const store = ledgerWith(mkDraft("x", "draft"));
    const approvals = new MemoryPendingApprovalStore();
    await dryRunSweep(store, approvals);
    const rejected = await rejectDraft(store, approvals, DATE, "x");
    expect(rejected.ok).toBe(true);
    expect(store.getDraft(DATE, "x")?.status).toBe("failed");
    const calls: string[] = [];
    const live = await publishDueDrafts({
      env: LIVE_ENV,
      tokens: { X_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      date: DATE,
      transport: okTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
      nowMs: MON_0900,
    });
    expect(live.results.find((r) => r.channel === "x")?.outcome).toBe("skipped");
    expect(calls).toHaveLength(0);
  });

  it("the goal path: a dry-run firing counts as run, and the next live firing publishes exactly once", async () => {
    const store = new MemorySocialLedger();
    const approvals = new MemoryPendingApprovalStore();
    const dryRun = await executeSocialGoal({
      env: DRY_RUN_ENV,
      tokens: {},
      store,
      approvals,
      briefProvider: () => "Morning brief.",
      nowMs: MON_0900,
      dryRunSink: createMemoryDryRunSink(),
    });
    expect(dryRun.fired).toBe(true);
    expect(store.getDraft(DATE, "x")?.status).toBe("dry-run-posted");
    const calls: string[] = [];
    const live = await executeSocialGoal({
      env: LIVE_ENV,
      tokens: { X_ACCESS_TOKEN: "test-token" },
      store,
      approvals,
      briefProvider: () => "Morning brief.",
      nowMs: MON_0900,
      transport: okTransport(calls),
      dryRunSink: createMemoryDryRunSink(),
    });
    expect(live.fired).toBe(true);
    expect(calls).toHaveLength(1);
    expect(store.getDraft(DATE, "x")?.status).toBe("posted");
    expect(store.getDraft(DATE, "x")?.platformPostId).toBe("platform-123");
  });
});

describe("draft store guard (#1171)", () => {
  it("accepts the dry-run-posted status and rejects an unknown status string", () => {
    const base = {
      id: "d1",
      date: DATE,
      channel: "x",
      text: "hi",
      createdAtMs: 0,
      originalLength: 2,
      truncated: false,
    };
    expect(isSocialDraft({ ...base, status: "dry-run-posted" })).toBe(true);
    expect(isSocialDraft({ ...base, status: "posted" })).toBe(true);
    expect(isSocialDraft({ ...base, status: "bogus-status" })).toBe(false);
    expect(isSocialDraft({ ...base, status: 42 })).toBe(false);
  });
});
