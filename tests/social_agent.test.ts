import { describe, it, expect } from "vitest";
import { buildDailyDrafts, publishDraft } from "../src/agents/socialAgent";
import { MemorySocialLedger } from "../src/agents/social/ledger";

// 2026-10-26 is a Monday; 13:00Z = 09:00 EDT.
const MON_0900 = Date.parse("2026-10-26T13:00:00Z");
const ENABLED = {
  SOCIAL_POSTING_ENABLED: "1",
  // Phase 3 (#6550): SOCIAL_AUTONOMOUS_CHANNELS lives in
  // environment.config.json ("threads" in production), so a bare env
  // no longer resolves the code default ["threads", "x"]. These
  // tests pin the five-default-channel draft set (incl. x), so the
  // list is set explicitly here.
  SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
};

describe("buildDailyDrafts early returns", () => {
  it("returns postingDisabled and writes nothing when posting is off", async () => {
    const store = new MemorySocialLedger();
    const res = await buildDailyDrafts({ env: {}, brief: "Morning brief.", nowMs: MON_0900, store });
    expect(res.status).toBe("postingDisabled");
    expect(res.date).toBeNull();
    expect(res.channels).toEqual([]);
    expect(store.listDrafts("2026-10-26")).toEqual([]);
  });

  it("returns noBrief and writes nothing for an empty or whitespace-only brief", async () => {
    for (const brief of ["", "   "]) {
      const store = new MemorySocialLedger();
      const res = await buildDailyDrafts({ env: ENABLED, brief, nowMs: MON_0900, store });
      expect(res.status).toBe("noBrief");
      expect(store.listDrafts("2026-10-26")).toEqual([]);
    }
  });
});

describe("buildDailyDrafts draft set", () => {
  it("builds one draft per default channel with the confirmed dispositions", async () => {
    const store = new MemorySocialLedger();
    const res = await buildDailyDrafts({ env: ENABLED, brief: "Morning brief.", nowMs: MON_0900, store });
    expect(res.status).toBe("drafts");
    expect(res.date).toBe("2026-10-26");
    const byChannel = new Map(res.channels.map((c) => [c.channel, c]));
    expect([...byChannel.keys()].sort()).toEqual([
      "facebook",
      "instagram",
      "linkedin",
      "threads",
      "x",
    ]);
    expect(byChannel.get("threads")?.disposition).toBe("autonomous");
    expect(byChannel.get("x")?.disposition).toBe("autonomous");
    expect(byChannel.get("facebook")?.disposition).toBe("approval");
    expect(byChannel.get("instagram")?.disposition).toBe("approval");
    expect(byChannel.get("linkedin")?.disposition).toBe("approval");
    for (const entry of res.channels) {
      expect(entry.draft).not.toBeNull();
      expect(entry.draft?.text).toBe("Morning brief.");
      expect(entry.draft?.status).toBe("draft");
    }
    expect(store.listDrafts("2026-10-26")).toHaveLength(5);
  });

  it("is idempotent: a second build the same day returns the first draft set", async () => {
    const store = new MemorySocialLedger();
    const first = await buildDailyDrafts({ env: ENABLED, brief: "Morning brief.", nowMs: MON_0900, store });
    const second = await buildDailyDrafts({ env: ENABLED, brief: "Morning brief.", nowMs: MON_0900, store });
    const firstIds = first.channels.map((c) => c.draft?.id).sort();
    const secondIds = second.channels.map((c) => c.draft?.id).sort();
    expect(secondIds).toEqual(firstIds);
    expect(store.listDrafts("2026-10-26")).toHaveLength(5);
  });

  it("truncates a long brief per channel instead of failing", async () => {
    const store = new MemorySocialLedger();
    const brief = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const res = await buildDailyDrafts({ env: ENABLED, brief, nowMs: MON_0900, store });
    const x = res.channels.find((c) => c.channel === "x");
    expect(x?.draft?.truncated).toBe(true);
    expect(x?.draft?.text.length).toBeLessThanOrEqual(280);
    expect(x?.draft?.originalLength).toBe(brief.length);
  });

  it("reports an unknown configured channel as an error entry, never a draft", async () => {
    const store = new MemorySocialLedger();
    const res = await buildDailyDrafts({
      env: { ...ENABLED, SOCIAL_AUTONOMOUS_CHANNELS: "threads,tiktok" },
      brief: "Morning brief.",
      nowMs: MON_0900,
      store,
    });
    const bad = res.channels.find((c) => c.channel === "tiktok");
    expect(bad).toBeDefined();
    expect(bad?.draft).toBeNull();
    expect(bad?.error).toMatch(/unknown/i);
    expect(bad?.disposition).toBe("approval");
  });

  it("respects a moved channel: approval-listed x needs approval", async () => {
    const store = new MemorySocialLedger();
    const res = await buildDailyDrafts({
      env: {
        ...ENABLED,
        SOCIAL_AUTONOMOUS_CHANNELS: "threads",
        SOCIAL_APPROVAL_CHANNELS: "x,facebook",
      },
      brief: "Morning brief.",
      nowMs: MON_0900,
      store,
    });
    expect(res.channels.find((c) => c.channel === "x")?.disposition).toBe("approval");
  });
});

describe("publishDraft guard", () => {
  it("refuses every publish attempt with not_implemented_phase5", () => {
    for (const channel of ["threads", "x", "facebook"]) {
      expect(publishDraft({ channel, draftId: "d1" })).toEqual({
        ok: false,
        error: "not_implemented_phase5",
      });
    }
  });
});
