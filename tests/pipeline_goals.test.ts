/**
 * #1224 — pipeline goals: ordered stages in one scheduled firing.
 *
 * Executor-level tests (generic executor + social stage functions,
 * memory stores). The pipeline executor runs stages back-to-back in
 * a single firing; a stage receives the prior stage's context; a
 * failed stage halts later stages; a skipped stage ends the run as
 * skipped; a re-fire after a failure resumes at the first incomplete
 * stage via the ledger (no duplicate work).
 */
import { describe, it, expect } from "vitest";
import {
  executePipeline,
  MemoryPipelineLedger,
  type PipelineStageContext,
  type PipelineStageOutcome,
} from "../src/agents/pipeline";
import {
  runSocialDailyPipeline,
  SOCIAL_DAILY_PIPELINE_ID,
  SOCIAL_DAILY_PIPELINE_STAGES,
} from "../src/agents/social/pipeline";
import { MemorySocialLedger } from "../src/agents/social/ledger";
import {
  MemoryPendingApprovalStore,
  approveDraft,
} from "../src/agents/social/approvals";
import type { SocialBriefStore } from "../src/agents/social/briefStore";
import { createMemoryDryRunSink } from "../src/agents/social/publisher";
import { OPERATION_CATALOG } from "../src/orchestrate";

// Monday 2026-10-26 09:00 EDT = 13:00Z.
const MON_0900 = Date.parse("2026-10-26T13:00:00Z");
const ENABLED = {
  SOCIAL_POSTING_ENABLED: "1",
  // Phase 3 (#6550): SOCIAL_AUTONOMOUS_CHANNELS lives in
  // environment.config.json ("threads" in production), so a bare env
  // no longer resolves the code default ["threads", "x"]. This
  // pipeline pins the two-autonomous-channel shape (x + threads),
  // so the list is set explicitly here.
  SOCIAL_AUTONOMOUS_CHANNELS: "threads,x",
};

function memoryBriefStore(initial: Record<string, string> = {}): SocialBriefStore & {
  calls: string[];
} {
  const data = new Map(Object.entries(initial));
  const calls: string[] = [];
  return {
    calls,
    async getBrief(date: string) {
      calls.push(date);
      return data.has(date) ? data.get(date)! : null;
    },
    async putBrief(date: string, text: string) {
      data.set(date, text);
    },
  };
}

function socialDeps(overrides: Record<string, unknown> = {}) {
  const store = new MemorySocialLedger();
  const approvals = new MemoryPendingApprovalStore();
  const ledger = new MemoryPipelineLedger();
  const sink = createMemoryDryRunSink();
  const briefStore = memoryBriefStore({ "2026-10-26": "Morning brief." });
  return {
    store,
    approvals,
    ledger,
    sink,
    briefStore,
    run: (extra: Record<string, unknown> = {}) =>
      runSocialDailyPipeline({
        env: ENABLED,
        tokens: {},
        store,
        approvals,
        briefStore,
        ledger,
        nowMs: MON_0900,
        dryRunSink: sink,
        ...overrides,
        ...extra,
      }),
  };
}

describe("executePipeline (generic executor)", () => {
  it("runs stages in order and passes prior-stage context to later stages", async () => {
    const seen: string[] = [];
    const ledger = new MemoryPipelineLedger();
    const ctx: PipelineStageContext = { date: "2026-10-26" };
    const result = await executePipeline({
      pipelineId: "pipeline:test",
      runKey: "pipeline:test:2026-10-26",
      date: "2026-10-26",
      stages: ["a", "b", "c"],
      ledger,
      context: ctx,
      stageFns: {
        a: async (c) => {
          seen.push("a");
          c.brief = "hello";
          return { status: "completed" };
        },
        b: async (c) => {
          seen.push(`b:${c.brief}`);
          return { status: "completed" };
        },
        c: async (c) => {
          seen.push(`c:${c.brief}:${c.date}`);
          return { status: "completed" };
        },
      },
    });
    expect(seen).toEqual(["a", "b:hello", "c:hello:2026-10-26"]);
    expect(result.status).toBe("completed");
    expect(result.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "a:completed",
      "b:completed",
      "c:completed",
    ]);
  });

  it("halts later stages on a stage failure and records failed", async () => {
    const ran: string[] = [];
    const ledger = new MemoryPipelineLedger();
    const result = await executePipeline({
      pipelineId: "pipeline:test",
      runKey: "pipeline:test:2026-10-26",
      date: "2026-10-26",
      stages: ["a", "b", "c"],
      ledger,
      context: { date: "2026-10-26" },
      stageFns: {
        a: async () => {
          ran.push("a");
          return { status: "completed" };
        },
        b: async () => {
          ran.push("b");
          throw new Error("boom in b");
        },
        c: async () => {
          ran.push("c");
          return { status: "completed" };
        },
      },
    });
    expect(ran).toEqual(["a", "b"]);
    expect(result.status).toBe("failed");
    expect(result.errors.join(" ")).toMatch(/boom in b/);
    const record = await ledger.getRun("pipeline:test:2026-10-26");
    expect(record?.status).toBe("failed");
    expect(record?.stages).toEqual({ a: "completed", b: "failed" });
  });

  it("ends the run skipped when a stage skips, without running later stages", async () => {
    const ran: string[] = [];
    const ledger = new MemoryPipelineLedger();
    const result = await executePipeline({
      pipelineId: "pipeline:test",
      runKey: "pipeline:test:2026-10-26",
      date: "2026-10-26",
      stages: ["a", "b", "c"],
      ledger,
      context: { date: "2026-10-26" },
      stageFns: {
        a: async () => {
          ran.push("a");
          return { status: "skipped", detail: "nothing to do" };
        },
        b: async () => {
          ran.push("b");
          return { status: "completed" };
        },
        c: async () => {
          ran.push("c");
          return { status: "completed" };
        },
      },
    });
    expect(ran).toEqual(["a"]);
    expect(result.status).toBe("skipped");
  });

  it("resumes a failed run at the first incomplete stage without redoing completed work", async () => {
    const calls: Record<string, number> = { a: 0, b: 0, c: 0 };
    const ledger = new MemoryPipelineLedger();
    let failB = true;
    const stageFns = {
      a: async () => {
        calls.a++;
        return { status: "completed" } as PipelineStageOutcome;
      },
      b: async () => {
        calls.b++;
        if (failB) throw new Error("b exploded");
        return { status: "completed" } as PipelineStageOutcome;
      },
      c: async () => {
        calls.c++;
        return { status: "completed" } as PipelineStageOutcome;
      },
    };
    const input = {
      pipelineId: "pipeline:test",
      runKey: "pipeline:test:2026-10-26",
      date: "2026-10-26",
      stages: ["a", "b", "c"],
      ledger,
      context: { date: "2026-10-26" },
      stageFns,
    };
    const first = await executePipeline(input);
    expect(first.status).toBe("failed");
    expect(calls).toEqual({ a: 1, b: 1, c: 0 });
    failB = false;
    const second = await executePipeline(input);
    expect(second.status).toBe("completed");
    // a was NOT re-run; b and c ran on the resume.
    expect(calls).toEqual({ a: 1, b: 2, c: 1 });
    expect(second.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "a:completed",
      "b:completed",
      "c:completed",
    ]);
  });

  it("a skipped run does not pin stages: a later re-fire runs the full pipeline", async () => {
    const calls: Record<string, number> = { a: 0, b: 0 };
    const ledger = new MemoryPipelineLedger();
    let skipA = true;
    const stageFns = {
      a: async () => {
        calls.a++;
        return skipA
          ? ({ status: "skipped", detail: "nope" } as PipelineStageOutcome)
          : ({ status: "completed" } as PipelineStageOutcome);
      },
      b: async () => {
        calls.b++;
        return { status: "completed" } as PipelineStageOutcome;
      },
    };
    const input = {
      pipelineId: "pipeline:test",
      runKey: "pipeline:test:2026-10-26",
      date: "2026-10-26",
      stages: ["a", "b"],
      ledger,
      context: { date: "2026-10-26" },
      stageFns,
    };
    expect((await executePipeline(input)).status).toBe("skipped");
    expect(calls).toEqual({ a: 1, b: 0 });
    skipA = false;
    expect((await executePipeline(input)).status).toBe("completed");
    expect(calls).toEqual({ a: 2, b: 1 });
  });
});

describe("social pipeline stages", () => {
  it("exposes the social-daily pipeline id and stage order", () => {
    expect(SOCIAL_DAILY_PIPELINE_ID).toBe("pipeline:social-daily");
    expect([...SOCIAL_DAILY_PIPELINE_STAGES]).toEqual([
      "social.feed",
      "social.generate",
      "social.deliver",
    ]);
  });

  it("the catalog lists pipeline:social-daily so addGoal accepts it", () => {
    const social = OPERATION_CATALOG.find((e) => e.agent === "social");
    expect(social?.operations).toContain("pipeline:social-daily");
  });

  it("runs feed → generate → deliver: drafts built and autonomous channels dry-run published", async () => {
    const d = socialDeps();
    const res = await d.run();
    expect(res.status).toBe("completed");
    expect(res.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "social.feed:completed",
      "social.generate:completed",
      "social.deliver:completed",
    ]);
    expect(d.store.getDraft("2026-10-26", "x")?.status).toBe("dry-run-posted");
    expect(d.store.getDraft("2026-10-26", "threads")?.status).toBe("dry-run-posted");
    expect(d.store.getDraft("2026-10-26", "facebook")?.status).toBe("draft");
    expect(d.approvals.listPending("2026-10-26").map((p) => p.channel)).toContain("facebook");
    expect(d.sink.records.map((r) => r.channel).sort()).toEqual(["threads", "x"]);
  });

  it("noBrief feed ends the run skipped: no drafts, no deliver attempt", async () => {
    const d = socialDeps();
    const emptyBrief = memoryBriefStore({});
    const res = await d.run({ briefStore: emptyBrief });
    expect(res.status).toBe("skipped");
    expect(res.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "social.feed:skipped",
    ]);
    expect(d.store.listDrafts("2026-10-26")).toEqual([]);
    expect(d.sink.records).toEqual([]);
    expect(d.approvals.listPending("2026-10-26")).toEqual([]);
  });

  it("a whitespace-only brief is noBrief, never invented content", async () => {
    const d = socialDeps();
    const res = await d.run({ briefStore: memoryBriefStore({ "2026-10-26": "   " }) });
    expect(res.status).toBe("skipped");
    expect(d.store.listDrafts("2026-10-26")).toEqual([]);
  });

  it("feed reads the brief store only: the stored text is the draft text verbatim", async () => {
    const d = socialDeps();
    await d.run({ briefStore: memoryBriefStore({ "2026-10-26": "Exact words here." }) });
    expect(d.store.getDraft("2026-10-26", "x")?.text).toBe("Exact words here.");
  });

  it("re-fire after a mid-pipeline failure resumes without duplicate drafts or Slack cards", async () => {
    const d = socialDeps();
    const slackCalls: string[] = [];
    const slackPost = async (_url: string, _headers: Record<string, string>, body: string) => {
      slackCalls.push(body);
      return { status: 200, body: "ok" };
    };
    const slackEnv = { SLACK_WEBHOOK_URL: "https://hooks.slack.test/xxx" };
    // First run: deliver's Slack pass throws mid-way (store rigged to
    // fail draft puts during publish is wrong — instead fail the
    // ledger write between generate and deliver by breaking the
    // ledger on its second put). Simpler deterministic failure:
    // make the brief store throw on the SECOND run's feed is not it.
    // Here: fail generate once via a throwing ledger on draft put.
    let failDraftPuts = true;
    const failingStore = new (class extends MemorySocialLedger {
      override putDraft(draft: Parameters<MemorySocialLedger["putDraft"]>[0]) {
        if (failDraftPuts) throw new Error("draft store down");
        return super.putDraft(draft);
      }
    })();
    const first = await d.run({
      store: failingStore,
      slackPost,
      slackEnv,
    });
    expect(first.status).toBe("failed");
    expect(first.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "social.feed:completed",
      "social.generate:failed",
    ]);
    // The brief was read exactly once so far; the resume must not re-read it.
    expect(d.briefStore.calls).toEqual(["2026-10-26"]);
    failDraftPuts = false;
    const second = await d.run({
      store: failingStore,
      slackPost,
      slackEnv,
    });
    expect(second.status).toBe("completed");
    // Feed NOT re-run on resume; generate + deliver ran.
    expect(d.briefStore.calls).toEqual(["2026-10-26"]);
    expect(second.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "social.feed:completed",
      "social.generate:completed",
      "social.deliver:completed",
    ]);
    // No duplicate drafts (one per date+channel) and exactly one
    // Slack card for the approval-channel draft.
    expect(failingStore.listDrafts("2026-10-26").map((x) => x.channel).sort()).toEqual([
      "facebook",
      "instagram",
      "linkedin",
      "threads",
      "x",
    ]);
    expect(slackCalls.length).toBe(3);
  });

  it("deliver keeps approval standing: unapproved drafts stay pending, approval publishes them", async () => {
    const d = socialDeps();
    await d.run();
    expect(d.store.getDraft("2026-10-26", "facebook")?.status).toBe("draft");
    await approveDraft(d.store, d.approvals, "2026-10-26", "facebook", "tester", MON_0900);
    const again = await d.run();
    expect(again.status).toBe("completed");
    expect(d.store.getDraft("2026-10-26", "facebook")?.status).toBe("dry-run-posted");
  });

  it("deliver keeps dry-run-posted semantics: a re-fire never double-records the dry run", async () => {
    const d = socialDeps();
    await d.run();
    expect(d.sink.records.map((r) => r.channel).sort()).toEqual(["threads", "x"]);
    await d.run();
    expect(d.sink.records.map((r) => r.channel).sort()).toEqual(["threads", "x"]);
  });

  it("deliver fails honestly on live-without-transport: error recorded, draft not posted", async () => {
    const d = socialDeps();
    const res = await d.run({
      env: { ...ENABLED, SOCIAL_LIVE_PUBLISHING: "1" },
      tokens: { X_ACCESS_TOKEN: "x-token", THREADS_ACCESS_TOKEN: "t-token" },
      transport: undefined,
    });
    expect(res.status).toBe("completed");
    expect(res.errors.join(" ")).toMatch(/no transport provided for live publish/);
    expect(d.store.getDraft("2026-10-26", "x")?.status).toBe("draft");
  });

  it("posting disabled ends the run skipped at generate, writing nothing", async () => {
    const d = socialDeps();
    const res = await d.run({ env: {} });
    expect(res.status).toBe("skipped");
    expect(res.stages.map((s) => `${s.name}:${s.status}`)).toEqual([
      "social.feed:completed",
      "social.generate:skipped",
    ]);
    expect(d.store.listDrafts("2026-10-26")).toEqual([]);
  });
});
