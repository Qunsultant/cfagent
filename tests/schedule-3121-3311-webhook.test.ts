/**
 * Issue #3311 — webhook-triggered scheduling: a workflow step calls an
 * authenticated, PDP-authorized webhook; the scheduler mints a scheduled
 * follow-up job/sub-job on the async-job chain with the correlation ID
 * (trigger, scheduleId, asyncJobId, workflowId) linking it to the
 * originating workflow run and schedule.
 *
 * Layers under test, in dependency order:
 *  1. Body schema (src/api/ingressSchemas.ts) — shape + login shape +
 *     capability allow-list membership.
 *  2. Submission + mint-record builders (src/services/scheduleWebhookFollowup.ts)
 *     — pure: capability allow-list, runAt parsing, per-capability
 *     requirements, §4 linkage, ledger-row shape.
 *  3. Edge handler (src/server/routes/scheduleWebhook.ts) — throttle,
 *     503 unconfigured, 401 bad/stale signature, 400 bad body, 413
 *     oversize, 409 replay, forward with trusted identity only.
 *  4. Worker routing (§17.3) — the route fires through server.ts
 *     dispatch (503 probe with no secret configured).
 *  5. DO route (src/agents/routes/schedules.ts) — edge-marker gate,
 *     trusted identity, PDP deny (403 + denied audit, no mint),
 *     mint + ledger row round-trip + both audits, unwired-host 500,
 *     ledger-write failure never breaks the mint.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("agents", () => {
  return { routeAgentRequest: async () => null, Agent: class MockAgent {} };
});
vi.mock("agents/mcp", () => {
  return { McpAgent: class MockMcpAgent {} };
});
vi.mock("agents/x402", () => {
  return { withX402: (cls: any) => cls };
});
vi.mock("../src/services/scheduledTasks", () => ({
  ScheduledTasksService: vi.fn(),
}));
vi.mock("../src/security/storageRetention", () => ({
  runStorageRetention: vi.fn(),
}));
vi.mock("../src/services/auditTamperAlert", () => ({
  verifyStoredAuditChainAndAlert: vi.fn(() => ({
    valid: true,
    brokenIndex: null,
    reason: null,
    alertRecorded: false,
  })),
}));
vi.mock("../src/security/etradeOAuth", () => ({
  getStoredTokens: vi.fn(),
  isTokenExpiredEt: vi.fn(() => false),
  etradeIdentityFromLogin: vi.fn(async () => ({})),
}));

import { DatabaseSync } from "node:sqlite";
import worker from "../src/server";
import { computeHmacSha256Hex } from "../src/services/cryptoUtils";
import {
  scheduleWebhookFollowupBodySchema,
  type ScheduleWebhookFollowupBody,
} from "../src/api/ingressSchemas";
import {
  SCHEDULE_WEBHOOK_FOLLOWUP_CAPABILITIES,
  buildScheduleWebhookFollowupSubmission,
  buildScheduleWebhookMintRecord,
  isScheduleWebhookFollowupCapability,
} from "../src/services/scheduleWebhookFollowup";
import {
  handleScheduleWebhookRequest,
  SCHEDULE_WEBHOOK_ROUTE,
} from "../src/server/routes/scheduleWebhook";
import {
  handleSchedulesRoutes,
  type SchedulesRouteContext,
} from "../src/agents/routes/schedules";
import { SqlJobRunRecordStore } from "../src/data/doSqliteJobRunRecordAdapter";
import { makeFakeSessionStore } from "./fake-session-store";
import type { Env } from "../src/types";

const SECRET = "unit-test-schedule-webhook-secret";
const OTHER_SECRET = "unit-test-other-secret";

const RUN_AT = new Date(Date.now() + 3_600_000).toISOString();

function validBody(overrides: Partial<ScheduleWebhookFollowupBody> = {}): Record<string, unknown> {
  return {
    workflowId: "wf-3311-1",
    scheduleId: "sched-3311-1",
    asyncJobId: "job-parent-3311-1",
    capability: "followup.report",
    runAt: RUN_AT,
    userLogin: "octocat",
    outcome: {
      kind: "stock",
      trigger: "scheduled",
      success: true,
      pdfKeys: ["r2/reports/stock-3311.pdf"],
      universe: "NASDAQ100",
      totalScanned: 100,
      matchedCount: 3,
    },
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

async function signedRequest(
  body: Record<string, unknown>,
  secret: string | undefined,
  extraHeaders: Record<string, string> = {},
): Promise<Request> {
  const rawBody = JSON.stringify(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...extraHeaders,
  };
  if (secret !== undefined) {
    headers["X-Signature-256"] = await computeHmacSha256Hex(secret, rawBody);
  }
  return new Request(`https://agent.test${SCHEDULE_WEBHOOK_ROUTE}`, {
    method: "POST",
    headers,
    body: rawBody,
  });
}

const allowThrottle = () => null;

// ===========================================================================
// 1. Body schema
// ===========================================================================

describe("scheduleWebhookFollowupBodySchema (#3311)", () => {
  it("accepts a valid followup.report body", () => {
    const parsed = scheduleWebhookFollowupBodySchema.safeParse(validBody());
    expect(parsed.success).toBe(true);
  });

  it("accepts followup.deliver and followup.notify capabilities", () => {
    for (const capability of ["followup.deliver", "followup.notify"] as const) {
      const parsed = scheduleWebhookFollowupBodySchema.safeParse(
        validBody({
          capability,
          channel: "slack",
          ...(capability === "followup.deliver"
            ? { artifacts: [{ key: "r2/reports/stock-3311.pdf", fileName: "report.pdf" }] }
            : { event: "completed" }),
        }),
      );
      expect(parsed.success, capability).toBe(true);
    }
  });

  it("rejects a missing workflowId", () => {
    const body = validBody();
    delete body.workflowId;
    expect(scheduleWebhookFollowupBodySchema.safeParse(body).success).toBe(false);
  });

  it("rejects an unknown capability", () => {
    expect(
      scheduleWebhookFollowupBodySchema.safeParse(validBody({ capability: "followup.smoke-signal" as never })).success,
    ).toBe(false);
  });

  it("rejects a login that is not login-shaped", () => {
    expect(
      scheduleWebhookFollowupBodySchema.safeParse(validBody({ userLogin: "not a login!" })).success,
    ).toBe(false);
  });

  it("rejects an outcome missing its required fields", () => {
    expect(
      scheduleWebhookFollowupBodySchema.safeParse(validBody({ outcome: { kind: "stock" } as never })).success,
    ).toBe(false);
  });

  it("rejects a missing timestamp", () => {
    const body = validBody();
    delete body.timestamp;
    expect(scheduleWebhookFollowupBodySchema.safeParse(body).success).toBe(false);
  });

  it("strips unknown keys (a smuggled secret never survives validation)", () => {
    const parsed = scheduleWebhookFollowupBodySchema.safeParse(
      validBody({ secret: "smuggled", signature: "smuggled" } as never),
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect("secret" in parsed.data).toBe(false);
      expect("signature" in parsed.data).toBe(false);
    }
  });
});

// ===========================================================================
// 2. Submission + mint-record builders (pure)
// ===========================================================================

describe("schedule webhook follow-up builders (#3311)", () => {
  it("lists exactly the three T4 follow-up capabilities", () => {
    expect([...SCHEDULE_WEBHOOK_FOLLOWUP_CAPABILITIES]).toEqual([
      "followup.report",
      "followup.deliver",
      "followup.notify",
    ]);
    expect(isScheduleWebhookFollowupCapability("followup.report")).toBe(true);
    expect(isScheduleWebhookFollowupCapability("executeAsyncJob")).toBe(false);
    expect(isScheduleWebhookFollowupCapability("autonomousMarketScreen")).toBe(false);
  });

  it("builds a followup.report submission with the §4 linkage", () => {
    const body = scheduleWebhookFollowupBodySchema.parse(validBody());
    const submission = buildScheduleWebhookFollowupSubmission(body) as Record<string, unknown>;
    expect(submission.capability).toBe("followup.report");
    expect(submission.trigger).toBe("webhook");
    expect(submission.triggeredBy).toBe("webhook");
    expect(submission.runAt).toBe(RUN_AT);
    expect(submission.parentJobId).toBe("job-parent-3311-1");
    expect(submission.jobKind).toBe("report");
    const payload = submission.payload as Record<string, unknown>;
    expect(payload.userLogin).toBe("octocat");
    expect(payload.outcome).toMatchObject({ kind: "stock", success: true });
    // The outcome copy carries the webhook's correlation ids even when the
    // outcome itself lacks them.
    expect(payload.outcome).toMatchObject({ scheduleId: "sched-3311-1", workflowId: "wf-3311-1" });
    const linkage = payload.ledgerLinkage as Record<string, unknown>;
    expect(linkage.trigger).toBe("async-chain");
    expect(linkage.scheduleId).toBe("sched-3311-1");
    expect(linkage.workflowId).toBe("wf-3311-1");
    // asyncJobId is restamped by submitAsyncJob to the minted row's own id;
    // the builder stamps the parent job id (the T4 planner convention).
    expect(linkage.asyncJobId).toBe("job-parent-3311-1");
    expect(submission.displayName).toContain("Generate report");
  });

  it("builds a followup.deliver submission only with channel + artifacts", () => {
    const base = validBody({
      capability: "followup.deliver",
      channel: "slack",
      artifacts: [{ key: "r2/reports/stock-3311.pdf", fileName: "report.pdf" }],
    });
    const submission = buildScheduleWebhookFollowupSubmission(
      scheduleWebhookFollowupBodySchema.parse(base),
    ) as Record<string, unknown>;
    expect(submission.capability).toBe("followup.deliver");
    expect(submission.jobKind).toBe("delivery");
    expect(submission.channel).toBe("slack");
    expect(() =>
      buildScheduleWebhookFollowupSubmission(
        scheduleWebhookFollowupBodySchema.parse(validBody({ capability: "followup.deliver" })),
      ),
    ).toThrow(/channel/);
    expect(() =>
      buildScheduleWebhookFollowupSubmission(
        scheduleWebhookFollowupBodySchema.parse(
          validBody({ capability: "followup.deliver", channel: "slack" }),
        ),
      ),
    ).toThrow(/artifacts/);
  });

  it("builds a followup.notify submission only with channel + event", () => {
    const submission = buildScheduleWebhookFollowupSubmission(
      scheduleWebhookFollowupBodySchema.parse(
        validBody({ capability: "followup.notify", channel: "email", event: "completed" }),
      ),
    ) as Record<string, unknown>;
    expect(submission.capability).toBe("followup.notify");
    expect(submission.jobKind).toBe("notification");
    expect(submission.channel).toBe("email");
    expect(() =>
      buildScheduleWebhookFollowupSubmission(
        scheduleWebhookFollowupBodySchema.parse(validBody({ capability: "followup.notify" })),
      ),
    ).toThrow(/channel/);
  });

  it("refuses an unknown capability and an unparseable runAt", () => {
    const body = scheduleWebhookFollowupBodySchema.parse(validBody());
    expect(() =>
      buildScheduleWebhookFollowupSubmission({ ...body, capability: "followup.nope" as never }),
    ).toThrow(/not webhook-mintable/);
    expect(() =>
      buildScheduleWebhookFollowupSubmission({ ...body, runAt: "not-a-time" }),
    ).toThrow(/ISO timestamp/);
  });

  it("builds the mint ledger record with the correlation ID", () => {
    const body = scheduleWebhookFollowupBodySchema.parse(validBody());
    const nowIso = new Date().toISOString();
    const record = buildScheduleWebhookMintRecord({ jobId: "job-minted-3311-1", body, nowIso });
    expect(record.operation).toBe("schedule.webhook.followup_minted");
    expect(record.triggeredBy).toBe("scheduled");
    expect(record.trigger).toBe("async-chain");
    expect(record.jobId).toBe("job-minted-3311-1");
    expect(record.asyncJobId).toBe("job-minted-3311-1");
    expect(record.scheduleId).toBe("sched-3311-1");
    expect(record.workflowId).toBe("wf-3311-1");
    expect(record.outcome).toBe("success");
  });
});

// ===========================================================================
// 3. Edge handler
// ===========================================================================

describe("handleScheduleWebhookRequest — edge gate (#3311)", () => {
  const env = (extra: Record<string, unknown> = {}) =>
    ({ INBOUND_SCHEDULE_WEBHOOK_SECRET: SECRET, ...extra }) as unknown as Env;

  it("answers 503 when the secret is not configured, and never dispatches", async () => {
    const dispatch = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await handleScheduleWebhookRequest(
      await signedRequest(validBody({ workflowId: "wf-3311-503" }), SECRET),
      {} as unknown as Env,
      allowThrottle,
      { dispatch },
    );
    expect(res.status).toBe(503);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 401 on a missing or wrong signature, and never dispatches", async () => {
    const dispatch = vi.fn(async () => new Response("{}", { status: 200 }));
    const noSig = await handleScheduleWebhookRequest(
      await signedRequest(validBody({ workflowId: "wf-3311-nosig" }), undefined),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(noSig.status).toBe(401);
    const wrongSig = await handleScheduleWebhookRequest(
      await signedRequest(validBody({ workflowId: "wf-3311-wrongsig" }), OTHER_SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(wrongSig.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 401 on a stale timestamp", async () => {
    const dispatch = vi.fn(async () => new Response("{}", { status: 200 }));
    const stale = new Date(Date.now() - 10 * 60_000).toISOString();
    const res = await handleScheduleWebhookRequest(
      await signedRequest(validBody({ workflowId: "wf-3311-stale", timestamp: stale }), SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(res.status).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 400 on a malformed body", async () => {
    const dispatch = vi.fn(async () => new Response("{}", { status: 200 }));
    const body = validBody({ workflowId: "wf-3311-badbody" });
    delete body.capability;
    const res = await handleScheduleWebhookRequest(
      await signedRequest(body, SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(res.status).toBe(400);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 413 on an oversize body", async () => {
    const dispatch = vi.fn(async () => new Response("{}", { status: 200 }));
    const big = validBody({ workflowId: "wf-3311-big" });
    (big.outcome as Record<string, unknown>).thesis = "x".repeat(200_000);
    const res = await handleScheduleWebhookRequest(
      await signedRequest(big, SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(res.status).toBe(413);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("answers 409 on a replayed delivery, and dispatches only once", async () => {
    const dispatch = vi.fn(async () => new Response(JSON.stringify({ jobId: "job-1" }), { status: 200 }));
    const body = validBody({ workflowId: "wf-3311-replay" });
    const first = await handleScheduleWebhookRequest(
      await signedRequest(body, SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(first.status).toBe(200);
    const second = await handleScheduleWebhookRequest(
      await signedRequest(body, SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(second.status).toBe(409);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  it("forwards a valid call with trusted identity only — no signature, no secret", async () => {
    let forwarded: Request | undefined;
    let forwardedLogin: string | undefined;
    const dispatch = vi.fn(async (login: string, req: Request) => {
      forwardedLogin = login;
      forwarded = req;
      return new Response(JSON.stringify({ jobId: "job-minted-3311-1", status: "queued" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    const res = await handleScheduleWebhookRequest(
      await signedRequest(validBody({ workflowId: "wf-3311-fwd" }), SECRET),
      env(),
      allowThrottle,
      { dispatch },
    );
    expect(res.status).toBe(200);
    expect(forwardedLogin).toBe("octocat");
    expect(forwarded).toBeDefined();
    expect(new URL(forwarded!.url).pathname).toBe("/schedules/webhook/followup");
    expect(forwarded!.headers.get("x-user-login")).toBe("octocat");
    expect(forwarded!.headers.get("x-schedule-webhook")).toBe("1");
    expect(forwarded!.headers.get("x-signature-256")).toBeNull();
    const forwardedBody = (await forwarded!.json()) as Record<string, unknown>;
    expect(forwardedBody.workflowId).toBe("wf-3311-fwd");
    expect("secret" in forwardedBody).toBe(false);
    const result = (await res.json()) as Record<string, unknown>;
    expect(result.jobId).toBe("job-minted-3311-1");
  });

  it("returns the throttle response when throttled, and never dispatches", async () => {
    const dispatch = vi.fn(async () => new Response("{}", { status: 200 }));
    const throttled = () => new Response("slow down", { status: 429 });
    const res = await handleScheduleWebhookRequest(
      await signedRequest(validBody({ workflowId: "wf-3311-throttle" }), SECRET),
      env(),
      throttled,
      { dispatch },
    );
    expect(res.status).toBe(429);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// 4. Worker routing (§17.3)
// ===========================================================================

describe("schedule webhook route through server.ts dispatch (#3311)", () => {
  it("fires through handleFetch: 503 with no secret configured", async () => {
    const res = await worker.fetch(
      await signedRequest(validBody({ workflowId: "wf-3311-route" }), SECRET),
      {} as unknown as Env,
    );
    expect(res.status).toBe(503);
  });
});

// ===========================================================================
// 5. DO route
// ===========================================================================

class SqliteTestStorage {
  readonly sqlite = new DatabaseSync(":memory:");
  exec(query: string, ...params: unknown[]): unknown[] {
    const stmt = this.sqlite.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
      return stmt.all(...(params as never[])) as unknown[];
    }
    stmt.run(...(params as never[]));
    return [];
  }
}

function doCtx(overrides: Partial<SchedulesRouteContext> = {}): {
  ctx: SchedulesRouteContext;
  sql: SqliteTestStorage;
  audits: Array<{ type: string; agent: string; payload: Record<string, unknown> }>;
  submitted: Array<Record<string, unknown>>;
} {
  const sql = new SqliteTestStorage();
  const audits: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];
  const submitted: Array<Record<string, unknown>> = [];
  const { namespace } = makeFakeSessionStore();
  const ctx = {
    env: { SESSION_STORE: namespace },
    agentCtx: { storage: { sql } },
    audit: (type: string, agent: string, payload: Record<string, unknown>) => {
      audits.push({ type, agent, payload });
    },
    listSchedules: vi.fn(async () => []),
    cancelSchedule: vi.fn(async () => true),
    getScheduleById: vi.fn(async () => undefined),
    schedule: vi.fn(async () => ({ id: "sched-1" })),
    scheduleEvery: vi.fn(async () => ({ id: "sched-every" })),
    getScreenerExecutionContext: vi.fn(async () => undefined),
    getOrm: vi.fn(() => ({})),
    autonomousMarketScreen: vi.fn(async () => undefined),
    autoRenewETradeTokens: vi.fn(async () => undefined),
    creatableScheduleCallbacks: ["autonomousOptionsAnalysis", "autonomousMarketScreen"],
    accountScopedScheduleCallbacks: new Set(["autonomousOptionsAnalysis", "autonomousMarketScreen"]),
    submitAsyncJob: vi.fn(async (spec: Record<string, unknown>) => {
      submitted.push(spec);
      return { jobId: "job-minted-3311-1", status: "queued", statusUrl: "/api/jobs/job-minted-3311-1" };
    }),
    ...overrides,
  } as unknown as SchedulesRouteContext;
  return { ctx, sql, audits, submitted };
}

const doReq = (body: unknown, headers: Record<string, string> = {}) =>
  new Request("https://agent.internal/schedules/webhook/followup", {
    method: "POST",
    headers: { "content-type": "application/json", "x-schedule-webhook": "1", "x-user-login": "octocat", ...headers },
    body: JSON.stringify(body),
  });

const urlOf = (path: string) => new URL(`https://agent.internal${path}`);

describe("handleSchedulesRoutes — POST /schedules/webhook/followup (#3311)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("mints the follow-up, writes the ledger row, and audits both the call and the mint", async () => {
    const { ctx, sql, audits, submitted } = doCtx();
    const res = await handleSchedulesRoutes(
      doReq(validBody({ workflowId: "wf-3311-do" })),
      urlOf("/schedules/webhook/followup"),
      "/schedules/webhook/followup",
      "test-session",
      ctx,
    );
    expect(res).not.toBeNull();
    expect(res!.status).toBe(200);
    const result = (await res!.json()) as Record<string, unknown>;
    expect(result.jobId).toBe("job-minted-3311-1");
    expect(result.status).toBe("queued");
    expect(result.workflowId).toBe("wf-3311-do");
    expect(submitted).toHaveLength(1);
    expect(submitted[0].capability).toBe("followup.report");
    expect(submitted[0].trigger).toBe("webhook");
    expect(submitted[0].runAt).toBe(RUN_AT);
    // The mint ledger row round-trips with the correlation ID.
    const rows = new SqlJobRunRecordStore(sql as never).listByJob("job-minted-3311-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].operation).toBe("schedule.webhook.followup_minted");
    expect(rows[0].trigger).toBe("async-chain");
    expect(rows[0].workflowId).toBe("wf-3311-do");
    expect(rows[0].scheduleId).toBe("sched-3311-1");
    expect(rows[0].asyncJobId).toBe("job-minted-3311-1");
    // Both the call and the mint are audited.
    const types = audits.map((a) => a.type);
    expect(types).toContain("schedule.webhook.received");
    expect(types).toContain("schedule.webhook.followup_minted");
  });

  it("refuses a call without the edge marker — never reaches the minter", async () => {
    const { ctx, submitted } = doCtx();
    const res = await handleSchedulesRoutes(
      doReq(validBody({ workflowId: "wf-3311-nomarker" }), { "x-schedule-webhook": "0" }),
      urlOf("/schedules/webhook/followup"),
      "/schedules/webhook/followup",
      "test-session",
      ctx,
    );
    expect(res!.status).toBe(401);
    expect(submitted).toHaveLength(0);
  });

  it("PDP denial fails closed with 403 + denied audit and mints nothing", async () => {
    const { namespace } = makeFakeSessionStore();
    const { ctx, audits, submitted } = doCtx({
      env: { SESSION_STORE: namespace, IAAA_PDP_ENABLED: "1" },
    } as Partial<SchedulesRouteContext>);
    const res = await handleSchedulesRoutes(
      doReq(validBody({ workflowId: "wf-3311-pdpdeny" })),
      urlOf("/schedules/webhook/followup"),
      "/schedules/webhook/followup",
      "test-session",
      ctx,
    );
    expect(res!.status).toBe(403);
    expect(submitted).toHaveLength(0);
    expect(audits.map((a) => a.type)).toContain("schedule.webhook.denied");
  });

  it("answers 400 on a body the schema rejects, and mints nothing", async () => {
    const { ctx, submitted } = doCtx();
    const body = validBody({ workflowId: "wf-3311-badcap" });
    (body as Record<string, unknown>).capability = "followup.nope";
    const res = await handleSchedulesRoutes(
      doReq(body),
      urlOf("/schedules/webhook/followup"),
      "/schedules/webhook/followup",
      "test-session",
      ctx,
    );
    expect(res!.status).toBe(400);
    expect(submitted).toHaveLength(0);
  });

  it("answers 500 when the host cannot submit async jobs", async () => {
    const { ctx } = doCtx({ submitAsyncJob: undefined });
    const res = await handleSchedulesRoutes(
      doReq(validBody({ workflowId: "wf-3311-nominter" })),
      urlOf("/schedules/webhook/followup"),
      "/schedules/webhook/followup",
      "test-session",
      ctx,
    );
    expect(res!.status).toBe(500);
  });

  it("a failed ledger write never breaks the mint (audited, not swallowed silently)", async () => {
    const throwingSql = {
      exec: () => {
        throw new Error("boom");
      },
    };
    const { ctx, audits, submitted } = doCtx({
      agentCtx: { storage: { sql: throwingSql } },
    } as Partial<SchedulesRouteContext>);
    const res = await handleSchedulesRoutes(
      doReq(validBody({ workflowId: "wf-3311-badledger" })),
      urlOf("/schedules/webhook/followup"),
      "/schedules/webhook/followup",
      "test-session",
      ctx,
    );
    expect(res!.status).toBe(200);
    expect(submitted).toHaveLength(1);
    expect(audits.map((a) => a.type)).toContain("schedule.webhook.mint_ledger_failed");
  });
});
