/**
 * Issue #2840 (#2837 sub-issue) — sessions per user, cross-login
 * run visibility/dedup, and quota enforcement.
 *
 * RED first: these tests fail until the slice lands. Coverage:
 * - Session cap: config default + invalid fallback, oldest-out
 *   eviction selection (including over-cap), active-session
 *   counting (expired / idle-expired / other-user / legacy
 *   sessions never count), enforcement seam (evicts oldest,
 *   fail-closed on unavailable listing or failed eviction), and
 *   the wired-login integration (10 live sessions + 1 login =
 *   oldest evicted, newest kept, total stays at the cap).
 * - Screens: the lock scope is the user, never the browser
 *   session — a second session for the same user is refused
 *   with the SAME in-flight run id + status, never a duplicate;
 *   a different user is unaffected. The run id is stable across
 *   both submitters (derived from user + universe + startedAt,
 *   no schema change, no token).
 * - Scheduled goals: a second trigger while a firing is in
 *   flight returns "already in flight" with the first run's id
 *   (never a duplicate firing), and the second submitter sees
 *   the first run's success record via listJobRuns.
 * - Orchestrator jobs: rows are scoped by the per-login
 *   instance key (sessionKey), not by browser session — two
 *   browser sessions for the same login see the same jobs.
 * - Workflows: starting the same job twice adopts the existing
 *   instance (existing:true, same workflowId), never a second run.
 * - Quota tiers: 70% watch / 90% escalate / 100% critical per
 *   budget on #1819's measurement base, with tiered alert
 *   dedup (a 90% alert fires even after the 70% alert for the
 *   same budget-day, and never twice for the same tier-day).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock("../src/orchestrate", () => ({
  OPERATION_CATALOG: [
    { agent: "test", binding: "SCHEDULED_AGENT", operations: ["test.op"], blurb: "" },
  ],
  createJob: vi.fn(async (_env: any, req: any) => ({ jobId: "job_test_1", ...req, status: "pending" })),
}));

vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: vi.fn(),
}));
vi.mock("../src/security/storageRetention", () => ({
  runStorageRetention: vi.fn(),
}));
vi.mock("../src/security/etradeOAuth", () => ({
  getStoredTokens: vi.fn(),
  isTokenExpiredEt: vi.fn(() => false),
  etradeIdentityFromLogin: vi.fn(async () => ({})),
}));

import { createJob } from "../src/orchestrate";
import { ScheduledAgent } from "../src/agents/scheduled-agent";
import {
  DEFAULT_MAX_CONCURRENT_SESSIONS_PER_USER,
  activeSessionsForUser,
  enforceSessionCap,
  resolveSessionCap,
  selectSessionEvictions,
  SessionCapError,
} from "../src/security/sessionCap";
import {
  screenRunIdFor,
  screenInFlightFromProbe,
  formatScreenAlreadyRunning,
} from "../src/services/screenInFlight";
import {
  GOAL_FIRING_STALE_MS,
  claimGoalFiring,
  goalFiringKey,
  goalFiringRunId,
  isGoalFiringStale,
  releaseGoalFiring,
} from "../src/services/goalFiringClaims";
import {
  evaluateCapTiers,
  tierAlertKey,
  buildTierAlertText,
} from "../src/telemetry/resourceRollup";
import { runResourceCapAlert } from "../src/agents/resourceGoals";
import { createInMemoryScreenRunLockPort } from "../src/data/createScreenRunLockPorts";
import { createInMemoryAsyncJobPorts } from "../src/data/createAsyncJobPorts";
import { startWorkflowInstance } from "../src/workflows/cfWorkflowAdapter";
import { makeFakeSessionStore } from "./fake-session-store";
import { createMemoryIdentityBindingStore } from "../src/security/identityBinding";
import { createMemoryAuditStore } from "../src/security/iaaaAudit";
import { completeWiredLogin } from "../src/security/iaaaLogin";
import type { Env } from "../src/types";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** One session record as the store holds it (cf. #2836 parsing). */
function sessionRecord(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    githubLogin: "octocat",
    githubName: "Octo Cat",
    createdAt: 1_000_000,
    firstCreatedAt: 1_000_000,
    lastActivityMs: 1_000_000,
    internalUserId: "user-1",
    ...overrides,
  });
}

const NOW = 700_000_000; // ~8.1 days after epoch: past the 7d absolute window for ancient sessions, inside it for fresh ones.

describe("session cap config (#2840 Q1)", () => {
  it("defaults to 10 concurrent sessions per user", () => {
    expect(DEFAULT_MAX_CONCURRENT_SESSIONS_PER_USER).toBe(10);
    expect(resolveSessionCap(undefined)).toBe(10);
  });

  it("falls back to the default for invalid caps (never 0, never unlimited)", () => {
    expect(resolveSessionCap(0)).toBe(10);
    expect(resolveSessionCap(-3)).toBe(10);
    expect(resolveSessionCap(2.5)).toBe(10);
    expect(resolveSessionCap(NaN)).toBe(10);
    expect(resolveSessionCap("bogus" as never)).toBe(10);
    expect(resolveSessionCap(3)).toBe(3);
  });

  it("evicts oldest-out: at the cap, exactly the oldest goes", () => {
    const sessions = [300, 100, 200].map((created, i) => ({
      sessionId: `s${i}`,
      createdMs: created,
      lastSeenMs: created,
      internalUserId: "user-1",
    }));
    const { kept, evicted } = selectSessionEvictions(sessions as never, 3);
    expect(evicted.map((s) => s.sessionId)).toEqual(["s1"]);
    expect(kept.map((s) => s.sessionId).sort()).toEqual(["s0", "s2"]);
  });

  it("evicts down to cap-1 when already over the cap", () => {
    const sessions = [100, 200, 300, 400].map((created, i) => ({
      sessionId: `s${i}`,
      createdMs: created,
      lastSeenMs: created,
      internalUserId: "user-1",
    }));
    const { kept, evicted } = selectSessionEvictions(sessions as never, 3);
    expect(evicted.map((s) => s.sessionId)).toEqual(["s0", "s1"]);
    expect(kept.map((s) => s.sessionId)).toEqual(["s2", "s3"]);
  });

  it("evicts nothing below the cap", () => {
    const sessions = [100, 200].map((created, i) => ({
      sessionId: `s${i}`,
      createdMs: created,
      lastSeenMs: created,
      internalUserId: "user-1",
    }));
    const { evicted } = selectSessionEvictions(sessions as never, 3);
    expect(evicted).toEqual([]);
  });
});

describe("session cap counting (#2840 Q1)", () => {
  const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
  it("counts only the user's own ACTIVE sessions", () => {
    const fresh = { createdAt: 699_000_000, firstCreatedAt: 699_000_000, lastActivityMs: 699_500_000 };
    const entries = [
      { key: uuid(1), value: sessionRecord(fresh) },
      // Other user: never counted.
      { key: uuid(2), value: sessionRecord({ ...fresh, internalUserId: "user-2" }) },
      // Legacy (no internalUserId): never counted toward a wired user.
      { key: uuid(3), value: JSON.stringify({ githubLogin: "octocat", createdAt: 699_000_000 }) },
      // Absolute-expired: ancient createdAt, even with fresh activity.
      { key: uuid(4), value: sessionRecord({ createdAt: 1, firstCreatedAt: 1, lastActivityMs: 699_500_000 }) },
      // Idle-expired: last activity more than the 8h wired window before NOW.
      { key: uuid(5), value: sessionRecord({ ...fresh, lastActivityMs: 1 }) },
      // Corrupt value: skipped, never counted.
      { key: uuid(6), value: "not-json{{{" },
      // Non-session key in the same bucket: skipped.
      { key: "iaaa-binding:user-1", value: sessionRecord(fresh) },
    ];
    const counted = activeSessionsForUser(entries, "user-1", NOW, 8 * 60 * 60 * 1000);
    expect(counted.map((s) => s.sessionId)).toEqual([uuid(1)]);
  });
});

describe("session cap enforcement seam (#2840 Q1)", () => {
  it("evicts the oldest live session and reports its id", async () => {
    const deleted: string[] = [];
    const entries = [100, 200, 300].map((created, i) => ({
      key: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
      value: sessionRecord({ createdAt: created, firstCreatedAt: created, lastActivityMs: created }),
    }));
    const result = await enforceSessionCap({
      listEntries: async () => entries,
      deleteSession: async (id: string) => void deleted.push(id),
      internalUserId: "user-1",
      cap: 3,
      nowMs: 1000,
      idleTimeoutMs: 8 * 60 * 60 * 1000,
    });
    expect(result.evictedSessionIds).toEqual([entries[0].key]);
    expect(deleted).toEqual([entries[0].key]);
  });

  it("fails closed when the listing is unavailable (never silently over cap)", async () => {
    await expect(
      enforceSessionCap({
        listEntries: async () => null,
        deleteSession: async () => {},
        internalUserId: "user-1",
        cap: 3,
        nowMs: NOW,
        idleTimeoutMs: 8 * 60 * 60 * 1000,
      }),
    ).rejects.toBeInstanceOf(SessionCapError);
    await expect(
      enforceSessionCap({
        listEntries: async () => null,
        deleteSession: async () => {},
        internalUserId: "user-1",
        cap: 3,
        nowMs: NOW,
        idleTimeoutMs: 8 * 60 * 60 * 1000,
      }),
    ).rejects.toThrow(/SESSION_CAP_UNAVAILABLE/);
  });

  it("fails closed when an eviction delete throws", async () => {
    const entries = [100, 200, 300].map((created, i) => ({
      key: `00000000-0000-0000-0000-${String(i + 1).padStart(12, "0")}`,
      value: sessionRecord({ createdAt: created, firstCreatedAt: created, lastActivityMs: created }),
    }));
    await expect(
      enforceSessionCap({
        listEntries: async () => entries,
        deleteSession: async () => {
          throw new Error("store down");
        },
        internalUserId: "user-1",
        cap: 3,
        nowMs: 1000,
        idleTimeoutMs: 8 * 60 * 60 * 1000,
      }),
    ).rejects.toThrow(/SESSION_CAP_EVICTION_FAILED/);
  });
});

describe("wired login enforces the cap (#2840 Q1 integration)", () => {
  function makeEnv() {
    const { namespace, store } = makeFakeSessionStore();
    return {
      env: { SESSION_STORE: namespace, SESSION_SECRET: "test-secret", APP_BASE_URL: "https://agent.test" } as unknown as Env,
      store,
    };
  }
  const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;

  it("an 11th login evicts the oldest session; the total stays at the cap", async () => {
    const { env, store } = makeEnv();
    const bindingStore = createMemoryIdentityBindingStore();
    const auditStore = createMemoryAuditStore();
    const nowMs = 10_000_000;
    // Seed 10 live sessions for the SAME user the login will bind to.
    // The binding id is derived, so seed after one login instead: log
    // in once to learn the internal id, then seed 9 more + the first.
    const first = await completeWiredLogin(
      env,
      "https://accounts.google.com",
      { subject: "google-sub-1", loginKey: "user@example.com", displayName: "Example", avatarUrl: "" },
      { bindingStore, nowMs, auditStore, auditTenantId: "primary" },
    );
    expect(first.status).toBe(302);
    const firstEntries = [...store.entries()].filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k));
    expect(firstEntries).toHaveLength(1);
    const firstSession = JSON.parse(firstEntries[0][1]);
    const internalUserId = firstSession.internalUserId as string;
    // 9 further sessions, older than the first login's session.
    for (let i = 0; i < 9; i++) {
      store.set(
        `sessions:${uuid(10 + i)}`,
        sessionRecord({
          githubLogin: "user@example.com",
          internalUserId,
          createdAt: nowMs - (10 - i) * 1000,
          firstCreatedAt: nowMs - (10 - i) * 1000,
          lastActivityMs: nowMs - 1000,
        }),
      );
    }
    expect([...store.entries()].filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k))).toHaveLength(10);
    // The 11th login (same subject → same internal id) must evict the
    // oldest seeded session and still succeed.
    const res = await completeWiredLogin(
      env,
      "https://accounts.google.com",
      { subject: "google-sub-1", loginKey: "user@example.com", displayName: "Example", avatarUrl: "" },
      { bindingStore, nowMs: nowMs + 5000, auditStore, auditTenantId: "primary" },
    );
    expect(res.status).toBe(302);
    const after = [...store.entries()].filter(([k]) => /^sessions:[0-9a-f-]{36}$/.test(k));
    expect(after).toHaveLength(10);
    expect(store.has(`sessions:${uuid(10)}`)).toBe(false);
    expect(store.has(`sessions:${uuid(18)}`)).toBe(true);
  });

  it("a login with an unavailable session listing fails visibly (distinct outcome, no session), never silently over cap", async () => {
    // No SESSION_STORE binding: the cap listing is unavailable,
    // so the login must fail closed before creating a session.
    // The user-visible shape is the login flow's own outcome
    // channel (302 to /login with the session_limit_unavailable
    // code), not a bare 503 — every login failure redirects.
    const env = { SESSION_SECRET: "test-secret", APP_BASE_URL: "https://agent.test" } as unknown as Env;
    const bindingStore = createMemoryIdentityBindingStore();
    const auditStore = createMemoryAuditStore();
    const res = await completeWiredLogin(
      env,
      "https://accounts.google.com",
      { subject: "google-sub-1", loginKey: "user@example.com", displayName: "Example", avatarUrl: "" },
      { bindingStore, nowMs: 5_000_000, auditStore, auditTenantId: "primary" },
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/login?auth_outcome=session_limit_unavailable");
    const events = await auditStore.list();
    expect(events.some((e) => (e as { errorCode?: string }).errorCode === "SESSION_CAP_UNAVAILABLE")).toBe(true);
  });
});

describe("screens: cross-login dedup + already-in-flight (#2840 Q2)", () => {
  it("a second browser session for the same user is refused with the SAME run id + status", () => {
    const lock = createInMemoryScreenRunLockPort();
    const first = lock.acquire("octocat", "nasdaq100", 1_000_000);
    expect(first.acquired).toBe(true);
    // Session B: same user, different browser session — the lock
    // scope never sees the browser session, only the user.
    const second = lock.acquire("octocat", "nasdaq100", 1_001_000);
    expect(second.acquired).toBe(false);
    expect(second.startedAt).toBe(1_000_000);
    const runIdA = screenRunIdFor("octocat", "nasdaq100", first.startedAt);
    const runIdB = screenRunIdFor("octocat", "nasdaq100", second.startedAt);
    expect(runIdA).toBe(runIdB);
    expect(runIdA).toBe("screen:octocat:nasdaq100:1000000");
    const probe = screenInFlightFromProbe(
      { running: true, startedAt: second.startedAt },
      "octocat",
      "nasdaq100",
    );
    expect(probe).toEqual({ running: true, startedAt: 1_000_000, runId: runIdA, status: "running" });
    // Exact refusal shape: the historical prefix verbatim, then
    // the #2840 run id + status (the #1993 source pin moved here
    // with the message itself).
    expect(formatScreenAlreadyRunning("octocat", "nasdaq100", second.startedAt, 1_001_000)).toBe(
      `Screen already running for nasdaq100 (started 1s ago). Run ${runIdA} is already in flight (status: running). Please wait for it to complete.`,
    );
  });

  it("a different user is unaffected by another user's in-flight screen", () => {
    const lock = createInMemoryScreenRunLockPort();
    expect(lock.acquire("octocat", "nasdaq100", 1_000_000).acquired).toBe(true);
    expect(lock.acquire("other-user", "nasdaq100", 1_000_000).acquired).toBe(true);
  });

  it("the probe reports no run id once the row is stale", () => {
    const probe = screenInFlightFromProbe({ running: false, startedAt: 1_000_000 }, "octocat", "nasdaq100");
    expect(probe).toEqual({ running: false, startedAt: 1_000_000, runId: null, status: "idle" });
  });
});

describe("scheduled goals: cross-login in-flight guard (#2840 Q2)", () => {
  function makeCtx(initialGoals: any[]) {
    const store = new Map<string, unknown>();
    store.set("goals", initialGoals);
    return {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => void store.set(k, v),
        delete: async (k: string) => void store.delete(k),
      },
      _store: store,
    };
  }
  function makeEnv() {
    return {
      PAYMENTS_AGENT: { idFromName: () => "default", get: () => ({ budgetCheck: async () => ({ allowed: true }) }) },
      SESSION_STORE: null,
    };
  }
  function testGoal() {
    return {
      id: "test-goal",
      name: "Test goal",
      cron: "0 6 * * *",
      operation: "test.op",
      budgetCents: 1,
      enabled: true,
    };
  }

  it("a second trigger during a firing reports already-in-flight with the first run id, and no duplicate firing happens", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.mocked(createJob).mockImplementationOnce(async (_env: any, req: any) => {
      await gate;
      return { jobId: "job_test_1", ...req, status: "pending" };
    });
    const ctx = makeCtx([testGoal()]);
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    // Session A starts the firing and blocks inside createJob.
    const first = agent.triggerGoal("test-goal");
    // Let the first firing reach the gate.
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    // Session B (same shared "default" instance, any login) triggers the same goal.
    const secondTick = await agent.triggerGoal("test-goal");
    expect(secondTick.jobsCreated).toBe(0);
    expect(secondTick.jobsSkipped).toBe(1);
    expect(secondTick.errors.join(" ")).toMatch(/already in flight/);
    const inFlightRunId = secondTick.errors.join(" ").match(/goal:test-goal:\d+/)?.[0];
    expect(inFlightRunId).toBeTruthy();
    // Release the first firing; it completes exactly once.
    release();
    const firstTick = await first;
    expect(firstTick.jobsCreated).toBe(1);
    const runs = await agent.listJobRuns("test-goal");
    expect(runs.filter((r) => r.outcome === "success")).toHaveLength(1);
    // The second submitter sees the first run's success record.
    expect(runs.some((r) => r.outcome === "success" && r.descriptor === "job:job_test_1")).toBe(true);
    expect(runs.some((r) => r.outcome === "skipped" && (r.detail ?? "").includes("already in flight"))).toBe(true);
  });

  it("a stale firing marker is taken over, never wedging the goal", () => {
    const marker = { runId: goalFiringRunId("g", 1000), startedMs: 1000, triggeredBy: "manual" as const, status: "running" as const };
    expect(isGoalFiringStale(marker, 1000 + GOAL_FIRING_STALE_MS)).toBe(false);
    expect(isGoalFiringStale(marker, 1000 + GOAL_FIRING_STALE_MS + 1)).toBe(true);
    expect(goalFiringKey("g")).toBe("goalFiring:g");
  });

  it("a completed marker never blocks a later claim, and release needs no delete (put-only stores re-fire)", async () => {
    // Regression for the #1224 pipeline re-fire: a storage with
    // get/put only (no delete) must still allow a sequential
    // re-fire after the first firing completes.
    const store = new Map<string, unknown>();
    const inMemory = new Map();
    const readMarker = async () => store.get(goalFiringKey("g"));
    const writeMarker = async (m: unknown) => void store.set(goalFiringKey("g"), m);
    const first = await claimGoalFiring(inMemory, { goalId: "g", triggeredBy: "manual", nowMs: 1000, readMarker, writeMarker });
    expect(first.claimed).toBe(true);
    const during = await claimGoalFiring(inMemory, { goalId: "g", triggeredBy: "manual", nowMs: 2000, readMarker, writeMarker });
    expect(during.claimed).toBe(false);
    expect(during.runId).toBe(first.runId);
    if (first.claimed) await releaseGoalFiring(inMemory, { goalId: "g", runId: first.runId, writeMarker });
    expect((store.get(goalFiringKey("g")) as { status: string }).status).toBe("completed");
    const second = await claimGoalFiring(inMemory, { goalId: "g", triggeredBy: "manual", nowMs: 3000, readMarker, writeMarker });
    expect(second.claimed).toBe(true);
  });

  it("sequential triggers on a put-only ctx both fire (no delete method anywhere)", async () => {
    vi.setSystemTime(new Date("2026-11-03T06:00:00Z"));
    vi.mocked(createJob).mockImplementation(async (_env: any, req: any) => ({ jobId: "job_seq", ...req, status: "pending" }));
    const store = new Map<string, unknown>();
    store.set("goals", [testGoal()]);
    const ctx = {
      storage: {
        get: async (k: string) => (store.has(k) ? store.get(k) : undefined),
        put: async (k: string, v: unknown) => void store.set(k, v),
      },
    };
    const agent = new ScheduledAgent(ctx as never, makeEnv() as never);
    const first = await agent.triggerGoal("test-goal");
    expect(first.jobsCreated).toBe(1);
    const second = await agent.triggerGoal("test-goal");
    expect(second.jobsCreated).toBe(1);
    expect(second.errors).toEqual([]);
  });
});

describe("orchestrator jobs: cross-login visibility (#2840 Q2)", () => {
  it("two browser sessions for the same login see the same jobs; another login does not", () => {
    const ports = createInMemoryAsyncJobPorts();
    ports.queue.ensureSchema();
    const sessionKey = "orchestrator-instance-for-octocat";
    ports.queue.insertQueued({
      jobId: "job-1",
      sessionId: sessionKey,
      capability: "test.cap",
      displayName: "Test",
      payloadJson: JSON.stringify({ hello: "world" }),
      nowIso: new Date().toISOString(),
    });
    // Browser session A and browser session B resolve to the SAME
    // per-login instance key, so both list the same row.
    expect(ports.read.listRows(sessionKey, 10).map((r) => r.job_id)).toEqual(["job-1"]);
    expect(ports.read.getRow("job-1", sessionKey)?.job_id).toBe("job-1");
    // A different login's instance sees nothing.
    expect(ports.read.listRows("orchestrator-instance-for-other", 10)).toEqual([]);
    expect(ports.read.getRow("job-1", "orchestrator-instance-for-other")).toBeUndefined();
  });
});

describe("workflows: same-job start adopts the existing instance (#2840 Q2)", () => {
  it("a second start of the same job returns existing:true with the same workflow id", async () => {
    const created: string[] = [];
    const binding = {
      create: async ({ id }: { id: string }) => {
        if (created.includes(id)) throw new Error("instance already exists");
        created.push(id);
        return { id };
      },
      get: async (id: string) => ({
        id,
        status: async () => ({ status: "running" }),
      }),
    };
    const command = { jobId: "job-1", goalId: "g", operation: "test.op" } as never;
    const first = await startWorkflowInstance(binding, command);
    expect(first.existing).toBe(false);
    const second = await startWorkflowInstance(binding, command);
    expect(second.existing).toBe(true);
    expect(second.workflowId).toBe(first.workflowId);
    expect(created).toHaveLength(1);
  });
});

describe("quota tiers (#2840 Q3)", () => {
  it("classifies watch (70%), escalate (90%), and critical (100%) per budget", () => {
    expect(evaluateCapTiers({ rowsRead: 3_499_999, rowsWritten: 0, ops: 0 }).rowsRead.tier).toBe("none");
    expect(evaluateCapTiers({ rowsRead: 3_500_000, rowsWritten: 0, ops: 0 }).rowsRead.tier).toBe("watch");
    expect(evaluateCapTiers({ rowsRead: 4_499_999, rowsWritten: 0, ops: 0 }).rowsRead.tier).toBe("watch");
    expect(evaluateCapTiers({ rowsRead: 4_500_000, rowsWritten: 0, ops: 0 }).rowsRead.tier).toBe("escalate");
    expect(evaluateCapTiers({ rowsRead: 4_999_999, rowsWritten: 0, ops: 0 }).rowsRead.tier).toBe("escalate");
    expect(evaluateCapTiers({ rowsRead: 5_000_000, rowsWritten: 0, ops: 0 }).rowsRead.tier).toBe("critical");
    expect(evaluateCapTiers({ rowsRead: 0, rowsWritten: 70_000, ops: 0 }).rowsWritten.tier).toBe("watch");
    expect(evaluateCapTiers({ rowsRead: 0, rowsWritten: 90_000, ops: 0 }).rowsWritten.tier).toBe("escalate");
    expect(evaluateCapTiers({ rowsRead: 0, rowsWritten: 100_000, ops: 0 }).rowsWritten.tier).toBe("critical");
    expect(evaluateCapTiers({ rowsRead: 0, rowsWritten: 0, ops: 90_000 }).doRequests.tier).toBe("escalate");
  });

  it("tier alert keys are distinct per budget + tier + day, so a 90% alert is never swallowed by the 70% alert", () => {
    expect(tierAlertKey("rowsRead", "watch", "2026-11-03")).toBe("rowsRead");
    expect(tierAlertKey("rowsRead", "escalate", "2026-11-03")).toBe("rowsRead:90");
    expect(tierAlertKey("rowsRead", "critical", "2026-11-03")).toBe("rowsRead:100");
    expect(buildTierAlertText("2026-11-03", "escalate", [{ budget: "rowsRead", cumulative: 4_600_000, limit: 5_000_000, pct: 0.92 }])).toMatch(/ESCALATION.*90%/);
    expect(buildTierAlertText("2026-11-03", "critical", [{ budget: "rowsRead", cumulative: 5_100_000, limit: 5_000_000, pct: 1.02 }])).toMatch(/CRITICAL.*100%/);
  });

  it("the cap-alert handler posts the escalation once per tier-day and never twice", async () => {
    const posts: string[] = [];
    const post = vi.fn(async (_url: string, _headers: unknown, body: string) => {
      posts.push(body);
      return { status: 200, body: "ok" };
    });
    const alertState = new Map<string, Record<string, unknown>>();
    const projectionRows = [
      { bucket: 0, ns: "sessions", op: "get", caller: "requireAuth", trigger: "user", ops: 1000, rows_read: 4_600_000, rows_written: 10 },
    ];
    const db = {
      prepare(sql: string) {
        return {
          bind(...params: unknown[]) {
            return {
              run: async () => {
                if (sql.includes("INSERT OR REPLACE INTO resource_alert_state")) {
                  const [budget, day, alerted_at, delivered, note] = params as [string, string, number, number, string | null];
                  alertState.set([budget, day].join("\0"), { budget, day, alerted_at, delivered, note });
                }
                return { success: true };
              },
              all: async () => {
                if (sql.includes("FROM resource_alert_state")) {
                  const [budget, day] = params as [string, string];
                  const row = alertState.get([budget, day].join("\0"));
                  return { results: row ? [row] : [] };
                }
                if (sql.includes("FROM resource_sql_ops")) return { results: projectionRows };
                return { results: [] };
              },
            };
          },
        };
      },
    };
    const env = { SLACK_WEBHOOK_URL: "https://hooks.slack.test/services/XXX" };
    const nowMs = Date.parse("2026-11-03T12:00:00Z");
    const first = await runResourceCapAlert({ db: db as never, nowMs, post: post as never, env: env as never });
    expect(first.tierAlerted).toContain("rowsRead:90");
    const postedAfterFirst = posts.length;
    expect(postedAfterFirst).toBeGreaterThanOrEqual(2); // 70% watch + 90% escalation
    const second = await runResourceCapAlert({ db: db as never, nowMs, post: post as never, env: env as never });
    expect(second.tierAlerted).toEqual([]);
    expect(posts.length).toBe(postedAfterFirst);
  });
});
