// @vitest-environment node
/**
 * Issue #4304 (sub-issue of #3976) — the provider verify path has
 * no deadline.
 *
 * The incident (2026-11-12): POST /data-providers/yahoo/verify ran
 * 21m 55s and died by host restart ([FAILURE_ASYNC_JOB_ORPHANED]),
 * with no re-arm — while the Alpaca feed-run alongside it was
 * re-armed. The verify is a direct probe through the provider
 * transition, not a pipeline job, and the probe await was bare:
 * a hung verify with a live host sits Running forever.
 *
 * This file pins the fix, in the #3992 leg idiom:
 * - the verify probe is raced against a named, configurable bound
 *   (FEED_JOB_VERIFY_MS, default 120s — see the default pin for
 *   the sizing justification) and settles with the stable code
 *   FEED_VERIFY_TIMEOUT when the provider never resolves;
 * - the bound is refused by name when misconfigured, never
 *   silently fallen back;
 * - the host-death orphan semantics are pinned as they are:
 *   the deadline covers in-flight hangs, not host death;
 *   settlement reaps stale rows with the orphan code, and re-arm
 *   covers feed dispatches — a verify row is settled, never
 *   re-armed.
 *
 * The never-resolving case uses a real never-resolving double
 * (a promise that never settles), not a mock that returns an
 * error — a proof against a double proves the code only against
 * its own assumptions (#3976 lesson, repeated on #3992).
 *
 * No live network: verifiers are injected fakes; the etrade
 * verifier the route builds by default is never invoked here.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, it, expect, vi, afterEach } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import {
  getProviderConfig,
  seedProviderConfigs,
} from "../src/trading/dataProviders/providerConfigStore";
import {
  transitionProvider,
  ProviderLifecycleError,
  type ProviderVerifier,
} from "../src/trading/dataProviders/lifecycle";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
} from "../src/agents/routes/dataProviders";
import type { Env } from "../src/types";
import {
  FEED_JOB_CODES,
} from "../src/services/feedJobCodes";
import {
  FEED_JOB_TIMEOUTS,
  FEED_JOB_TIMEOUT_KNOBS,
  resolveFeedJobTimeoutMs,
  resolveFeedJobTimeouts,
} from "../src/services/feedJobTimeouts";
import {
  ensureAsyncJobGraphColumns,
  recoverStaleRunningAsyncJobs,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";

afterEach(() => {
  vi.useRealTimers();
});

const ACTOR = "octocat";

function newStore(): MockSqlStorage {
  return new MockSqlStorage();
}

const okVerifier: ProviderVerifier = async () => ({
  ok: true,
  summary: "probe passed: status configured, conformance green",
});

/** A real never-resolving double: the promise never settles. */
const neverVerifier: ProviderVerifier = () => new Promise(() => {});

/** Drive a fresh provider id to `configured` through the service itself. */
async function driveToConfigured(sql: MockSqlStorage, id: string) {
  await transitionProvider(sql, id, "register", ACTOR, {
    verifier: okVerifier,
    register: { adapterKind: `${id}-adapter`, precedence: 42 },
  });
  await transitionProvider(sql, id, "configure", ACTOR, {
    verifier: okVerifier,
    configure: { credentialRef: "env:ACME_API_KEY" },
  });
  expect(getProviderConfig(sql, id as never)?.lifecycleState).toBe("configured");
}

describe("verify timeout: a never-resolving probe settles with the stable code (#4304)", () => {
  it("default bound: still pending at 119999ms, rejects FEED_VERIFY_TIMEOUT at 120000ms", async () => {
    const sql = newStore();
    await driveToConfigured(sql, "acme");
    vi.useFakeTimers();
    let settled: unknown = "PENDING";
    const p = transitionProvider(sql, "acme", "verify", ACTOR, { verifier: neverVerifier });
    p.then(
      () => { settled = "RESOLVED"; },
      (e: unknown) => { settled = e; },
    );
    await vi.advanceTimersByTimeAsync(119_999);
    expect(settled).toBe("PENDING");
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).not.toBe("PENDING");
    expect(settled).toBeInstanceOf(ProviderLifecycleError);
    expect((settled as ProviderLifecycleError).code).toBe("FEED_VERIFY_TIMEOUT");
    expect((settled as Error).message).toContain("120000");
  });

  it("explicit short bound: rejects FEED_VERIFY_TIMEOUT when the probe outruns it", async () => {
    const sql = newStore();
    await driveToConfigured(sql, "acme");
    vi.useFakeTimers();
    let settled: unknown = "PENDING";
    const p = transitionProvider(sql, "acme", "verify", ACTOR, {
      verifier: neverVerifier,
      verifyTimeoutMs: 50,
    });
    p.then(
      () => { settled = "RESOLVED"; },
      (e: unknown) => { settled = e; },
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBeInstanceOf(ProviderLifecycleError);
    expect((settled as ProviderLifecycleError).code).toBe("FEED_VERIFY_TIMEOUT");
  });

  it("a slow-but-finite probe is cut by the bound (the race abandons the leg)", async () => {
    const sql = newStore();
    await driveToConfigured(sql, "acme");
    vi.useFakeTimers();
    const slowVerifier: ProviderVerifier = () =>
      new Promise((resolve) => {
        setTimeout(() => resolve({ ok: true, summary: "late probe" }), 200);
      });
    let settled: unknown = "PENDING";
    const p = transitionProvider(sql, "acme", "verify", ACTOR, {
      verifier: slowVerifier,
      verifyTimeoutMs: 50,
    });
    p.then(
      () => { settled = "RESOLVED"; },
      (e: unknown) => { settled = e; },
    );
    await vi.advanceTimersByTimeAsync(50);
    expect(settled).toBeInstanceOf(ProviderLifecycleError);
    expect((settled as ProviderLifecycleError).code).toBe("FEED_VERIFY_TIMEOUT");
  });

  it("a fast verifier still passes (regression: the bound does not break normal verifies)", async () => {
    const sql = newStore();
    await driveToConfigured(sql, "acme");
    const record = await transitionProvider(sql, "acme", "verify", ACTOR, { verifier: okVerifier });
    expect(record.lifecycleState).toBe("verified");
  });

  it("a throwing verifier still rejects verification_failed, not the timeout code (regression)", async () => {
    const sql = newStore();
    await driveToConfigured(sql, "acme");
    const throwing: ProviderVerifier = async () => {
      throw new Error("probe exploded");
    };
    let caught: unknown = null;
    try {
      await transitionProvider(sql, "acme", "verify", ACTOR, { verifier: throwing });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ProviderLifecycleError);
    expect((caught as ProviderLifecycleError).code).toBe("verification_failed");
    expect((caught as Error).message).toContain("probe exploded");
  });

  it("an invalid explicit bound is refused by name, never treated as no deadline", async () => {
    const sql = newStore();
    await driveToConfigured(sql, "acme");
    await expect(
      transitionProvider(sql, "acme", "verify", ACTOR, { verifier: neverVerifier, verifyTimeoutMs: 0 }),
    ).rejects.toThrow("Invalid feed deadline bound 0 for FEED_VERIFY_TIMEOUT");
  });
});

describe("verify timeout: the bound is a named env knob (#4304, #4312 idiom)", () => {
  it("default is 120s: the conformance kit probes each declared capability in sequence (up to 4 for Yahoo), each one provider round-trip seconds-scale like the fetch leg (60s for one batch request); 120s is 2x the fetch bound and half the 240s execution bound — far above the normal multi-probe duration, far below the 90-minute executor backstop", () => {
    expect(FEED_JOB_TIMEOUTS.verifyMs).toBe(120_000);
    expect(resolveFeedJobTimeouts({}).verifyMs).toBe(120_000);
    expect(FEED_JOB_TIMEOUT_KNOBS.verifyMs).toBe("FEED_JOB_VERIFY_MS");
  });

  it("the knob overrides only the verify bound", () => {
    const resolved = resolveFeedJobTimeouts({ FEED_JOB_VERIFY_MS: "30000" });
    expect(resolved.verifyMs).toBe(30_000);
    expect(resolved.fetchMs).toBe(60_000);
    expect(resolved.executionMs).toBe(240_000);
  });

  it("a present invalid knob is refused by name, never silently fallen back", () => {
    expect(() =>
      resolveFeedJobTimeoutMs({}, FEED_JOB_TIMEOUT_KNOBS.verifyMs, FEED_JOB_TIMEOUTS.verifyMs),
    ).not.toThrow();
    for (const bad of ["0", "-5", "abc", "", "NaN", "Infinity"]) {
      expect(() =>
        resolveFeedJobTimeoutMs({ FEED_JOB_VERIFY_MS: bad }, FEED_JOB_TIMEOUT_KNOBS.verifyMs, FEED_JOB_TIMEOUTS.verifyMs),
      ).toThrow(`Invalid FEED_JOB_VERIFY_MS value "${bad}"`);
    }
    expect(() =>
      resolveFeedJobTimeoutMs({ FEED_JOB_VERIFY_MS: {} }, FEED_JOB_TIMEOUT_KNOBS.verifyMs, FEED_JOB_TIMEOUTS.verifyMs),
    ).toThrow("Invalid FEED_JOB_VERIFY_MS value");
  });

  it("the stable code is FEED_VERIFY_TIMEOUT", () => {
    expect(FEED_JOB_CODES.verifyTimeout).toBe("FEED_VERIFY_TIMEOUT");
  });
});

describe("verify timeout: the route resolves the knob and returns the code (#4304)", () => {
  function makeRouteCtx(sql: MockSqlStorage, overrides: Partial<DataProviderRoutesContext> = {}) {
    const auditRows: Array<{ type: string; agent: string; payload: Record<string, unknown> }> = [];
    const ctx: DataProviderRoutesContext = {
      env: {} as Env,
      sql,
      userLogin: ACTOR,
      recordAudit: (type, agent, payload) => {
        auditRows.push({ type, agent, payload });
        return { id: "audit-1", type, agent, payload, created_at: "2026-10-23T00:00:00.000Z" };
      },
      buildVerifier: () => neverVerifier,
      ...overrides,
    };
    return { ctx, auditRows };
  }

  function callRoute(ctx: DataProviderRoutesContext, method: string, path: string, body?: unknown): Promise<Response> {
    const url = new URL(`https://agent.internal${path}`);
    const request = new Request(url, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return handleDataProviderRoutes(request, url, path, "session-1", ctx) as Promise<Response>;
  }

  it("POST /data-providers/etrade/verify with a never-resolving probe and a 100ms knob returns 409 with code FEED_VERIFY_TIMEOUT, and the record stays configured", async () => {
    const sql = newStore();
    seedProviderConfigs(sql);
    expect(getProviderConfig(sql, "etrade" as never)?.lifecycleState).toBe("configured");
    const { ctx } = makeRouteCtx(sql, {
      env: { FEED_JOB_VERIFY_MS: "100" } as unknown as Env,
    });
    vi.useFakeTimers();
    let settled: unknown = "PENDING";
    const resP = callRoute(ctx, "POST", "/data-providers/etrade/verify");
    resP.then(
      (r) => { settled = r; },
      (e: unknown) => { settled = e; },
    );
    await vi.advanceTimersByTimeAsync(150);
    expect(settled).not.toBe("PENDING");
    const res = settled as Response;
    expect(res.status).toBe(409);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe("FEED_VERIFY_TIMEOUT");
    expect(getProviderConfig(sql, "etrade" as never)?.lifecycleState).toBe("configured");
  });
});

// ---------------------------------------------------------------------------
// Host-death orphan semantics (settlement + re-arm), mirrored harness from
// tests/async_job_recovery_rearm_4002.test.ts: real node:sqlite behind
// the family's ports, rows seeded at controlled ages.
// ---------------------------------------------------------------------------

/** SqlStorage-shaped executor over node:sqlite (rowsWritten surfaced like the DO cursor — same shim as #2358/#2567). */
function makeSql(db: DatabaseSync) {
  return {
    exec: (query: string, ...args: unknown[]) => {
      const stmt = db.prepare(query);
      if (/^\s*(SELECT|PRAGMA)/i.test(query)) {
        return stmt.all(...(args as never[])) as unknown[];
      }
      const info = stmt.run(...(args as never[]));
      const out = [] as unknown[] & { rowsWritten?: number };
      out.rowsWritten = Number(info.changes);
      return out;
    },
  };
}

const BASE_DDL = `CREATE TABLE IF NOT EXISTS mas_async_jobs (
  job_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, capability TEXT NOT NULL,
  display_name TEXT NOT NULL, status TEXT NOT NULL, payload_json TEXT NOT NULL,
  result_json TEXT, response_status INTEGER, error TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  started_at TEXT, completed_at TEXT
)`;

const MIN = 60 * 1000;
const isoAgo = (ms: number) => new Date(Date.now() - ms).toISOString();

interface RecoveryHarness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeRecoveryHarness(): RecoveryHarness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const audits: RecoveryHarness["audits"] = [];
  const ctx = {
    env: {},
    agentCtx: { storage: { sql } },
    ensureTables: () => {
      sql.exec(BASE_DDL);
      ensureAsyncJobGraphColumns(sql as never);
      return sql;
    },
    sessionKey: () => "owner-login-1",
    schedule: async () => ({}),
    audit: (type: string, _agent: unknown, payload: Record<string, unknown>) => {
      audits.push({ type, payload });
    },
    getOrm: () => {
      throw new Error("no orm in 4304 harness");
    },
  } as unknown as AsyncJobsContext;
  return { db, ctx, audits };
}

function seedRow(
  db: DatabaseSync,
  row: {
    jobId: string;
    startedAt: string | null;
    lastActivityAt?: string | null;
    status?: string;
    capability?: string;
    payloadJson?: string;
  },
): void {
  ensureAsyncJobGraphColumns(makeSql(db) as never);
  db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at, last_activity_at) VALUES (?, 'owner-login-1', ?, 'Seeded run', ?, ?, ?, ?, ?, ?)",
  ).run(
    row.jobId,
    row.capability ?? "screen.run",
    row.status ?? "running",
    row.payloadJson ?? "{}",
    row.startedAt,
    row.startedAt,
    row.startedAt,
    row.lastActivityAt ?? null,
  );
}

function allRows(db: DatabaseSync): Array<{
  job_id: string;
  status: string;
  payload_json: string;
  error: string | null;
}> {
  return db.prepare(
    "SELECT job_id, status, payload_json, error FROM mas_async_jobs",
  ).all() as Array<{ job_id: string; status: string; payload_json: string; error: string | null }>;
}

const verifyPayload = () =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: "/data-providers/yahoo/verify",
    headers: {},
    body: "{}",
  });

const feedRunPayload = () =>
  JSON.stringify({
    method: "POST",
    pathAndQuery: "/data-providers/yahoo/feed-run",
    headers: {},
    body: "{}",
  });

describe("host-death orphan semantics: the deadline covers hangs, settlement covers host death, re-arm covers feed runs only (#4304)", () => {
  it("a stale verify row is settled as orphaned and NOT re-armed, while a stale feed-run row beside it IS re-armed", async () => {
    const h = makeRecoveryHarness();
    const lastActivityAt = isoAgo(30 * MIN);
    seedRow(h.db, {
      jobId: "job-verify-1788aafa",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt,
      capability: "http.request",
      payloadJson: verifyPayload(),
    });
    seedRow(h.db, {
      jobId: "job-feed-run-b80f278d",
      startedAt: isoAgo(23 * MIN),
      lastActivityAt,
      capability: "http.request",
      payloadJson: feedRunPayload(),
    });

    const result = await recoverStaleRunningAsyncJobs(h.ctx);
    expect(result).toEqual({ examined: 2, failed: 2, rearmed: 1 });

    const rows = allRows(h.db);
    // The verify row: failed with the orphan code, no re-arm spawned for it.
    const verifyRow = rows.find((r) => r.job_id === "job-verify-1788aafa")!;
    expect(verifyRow.status).toBe("failed");
    expect(verifyRow.error).toContain("Orphaned by a host restart");
    expect(verifyRow.error).toContain(lastActivityAt);
    expect(rows.filter((r) => {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      return p.recoveryRearmOf === "job-verify-1788aafa";
    })).toHaveLength(0);
    // The feed-run row beside it: re-armed, same dispatch replayed.
    const rearmed = rows.filter((r) => {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      return p.recoveryRearmOf === "job-feed-run-b80f278d";
    });
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0].status).toBe("queued");

    const failed = h.audits.filter((a) => a.type === "async_job.failed");
    expect(failed).toHaveLength(2);
    expect(failed.every((a) => a.payload.errorCode === "FAILURE_ASYNC_JOB_ORPHANED")).toBe(true);
    const retried = h.audits.filter((a) => a.type === "async_job.retried");
    expect(retried).toHaveLength(1);
    expect(retried[0].payload.jobId).toBe("job-feed-run-b80f278d");
  });
});
