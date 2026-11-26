import { describe, it, expect } from "vitest";
import { executeSocialGoal } from "../src/agents/social/goalExecutor";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import { MemoryPendingApprovalStore, approveDraft } from "../src/agents/social/approvals";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";

// 2026-10-26 is a Monday; 13:00Z = 09:00 EDT.
const MON_0900 = Date.parse("2026-10-26T13:00:00Z");
// Phase 3 (#6550): SOCIAL_AUTONOMOUS_CHANNELS lives in
// environment.config.json ("threads" in production), so a bare env
// no longer resolves the code default ["threads", "x"]. These
// tests pin the two-autonomous-channel shape (x + threads), so
// the list is set explicitly here.
const ENABLED = { SOCIAL_POSTING_ENABLED: "1", SOCIAL_AUTONOMOUS_CHANNELS: "threads,x" };

function deps(overrides: Record<string, unknown> = {}) {
  const store = new MemorySocialLedger();
  const approvals = new MemoryPendingApprovalStore();
  const sink = createMemoryDryRunSink();
  return {
    store,
    approvals,
    sink,
    run: (extra: Record<string, unknown> = {}) =>
      executeSocialGoal({
        env: ENABLED,
        tokens: {},
        store,
        approvals,
        briefProvider: () => "Morning brief.",
        nowMs: MON_0900,
        dryRunSink: sink,
        ...overrides,
        ...extra,
      }),
  };
}

describe("executeSocialGoal", () => {
  it("builds drafts and dry-run publishes autonomous channels, holding approval channels pending", async () => {
    const d = deps();
    const res = await d.run();
    expect(res.fired).toBe(true);
    if (!res.fired) return;
    expect(res.date).toBe("2026-10-26");
    const byChannel = new Map(res.publish.results.map((r) => [r.channel, r]));
    expect(byChannel.get("x")?.outcome).toBe("posted");
    expect(byChannel.get("threads")?.outcome).toBe("posted");
    expect(byChannel.get("facebook")?.outcome).toBe("skipped");
    expect(byChannel.get("facebook")?.reason).toMatch(/awaiting approval/);
    expect(d.store.getDraft("2026-10-26", "x")?.status).toBe("dry-run-posted");
    expect(d.store.getDraft("2026-10-26", "facebook")?.status).toBe("draft");
    expect(d.approvals.listPending("2026-10-26").map((p) => p.channel)).toContain("facebook");
    expect(d.sink.records.map((r) => r.channel).sort()).toEqual(["threads", "x"]);
  });

  it("reports noBrief and writes nothing when the brief is null or blank", async () => {
    for (const brief of [null, "", "   "]) {
      const d = deps();
      const res = await d.run({ briefProvider: () => brief });
      expect(res).toEqual({ fired: false, reason: "noBrief" });
      expect(d.store.listDrafts("2026-10-26")).toEqual([]);
    }
  });

  it("reports postingDisabled and writes nothing when posting is off", async () => {
    const d = deps();
    const res = await d.run({ env: {} });
    expect(res).toEqual({ fired: false, reason: "postingDisabled" });
    expect(d.store.listDrafts("2026-10-26")).toEqual([]);
  });

  it("reports noDrafts when every configured channel is unknown", async () => {
    const d = deps();
    const res = await d.run({
      env: {
        ...ENABLED,
        SOCIAL_AUTONOMOUS_CHANNELS: "tiktok",
        SOCIAL_APPROVAL_CHANNELS: "myspace",
      },
    });
    expect(res).toEqual({ fired: false, reason: "noDrafts" });
    expect(d.store.listDrafts("2026-10-26")).toEqual([]);
  });

  it("approval end-to-end: build holds, approve, next run publishes", async () => {
    const d = deps();
    const first = await d.run();
    expect(first.fired).toBe(true);
    expect(d.store.getDraft("2026-10-26", "facebook")?.status).toBe("draft");
    const approved = await approveDraft(d.store, d.approvals, "2026-10-26", "facebook", "owner", MON_0900);
    expect(approved.ok).toBe(true);
    expect(d.approvals.listPending("2026-10-26").map((p) => p.channel)).not.toContain("facebook");
    const second = await d.run();
    expect(second.fired).toBe(true);
    if (!second.fired) return;
    const fb = second.publish.results.find((r) => r.channel === "facebook");
    expect(fb?.outcome).toBe("posted");
    expect(d.store.getDraft("2026-10-26", "facebook")?.status).toBe("dry-run-posted");
    // Already-posted autonomous drafts are skipped, never republished.
    expect(second.publish.results.find((r) => r.channel === "x")?.outcome).toBe("skipped");
  });

  it("never silently falls back to dry-run when live is requested but the token is missing", async () => {
    const d = deps();
    const res = await d.run({ env: { ...ENABLED, SOCIAL_LIVE_PUBLISHING: "1" }, tokens: {} });
    expect(res.fired).toBe(true);
    if (!res.fired) return;
    const x = res.publish.results.find((r) => r.channel === "x");
    expect(x?.outcome).toBe("error");
    expect(x?.reason).toMatch(/token/i);
    expect(d.store.getDraft("2026-10-26", "x")?.status).toBe("draft");
    expect(d.sink.records).toEqual([]);
  });

  it("reads the draft date in the goal time zone", async () => {
    // 2026-10-27T02:00Z is still 2026-10-26 22:00 in New York.
    const late = Date.parse("2026-10-27T02:00:00Z");
    const ny = deps();
    const nyRes = await ny.run({ nowMs: late, timeZone: "America/New_York" });
    expect(nyRes.fired).toBe(true);
    if (nyRes.fired) expect(nyRes.date).toBe("2026-10-26");
    const utc = deps();
    const utcRes = await utc.run({ nowMs: late, timeZone: "UTC" });
    expect(utcRes.fired).toBe(true);
    if (utcRes.fired) expect(utcRes.date).toBe("2026-10-27");
  });

  it("propagates a throwing brief provider so the caller can record the error", async () => {
    const d = deps();
    await expect(
      d.run({
        briefProvider: () => {
          throw new Error("brief exploded");
        },
      }),
    ).rejects.toThrow(/brief exploded/);
  });
});
