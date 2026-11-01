// @vitest-environment node
/**
 * Issue #2567 (#2494) — stuck-running honesty.
 *
 * Detection rides the async-job READ path (the same seam as the
 * 2h stale-running reap): a job still `running` past the
 * configured threshold (default 30 min, STUCK_RUN_ALERT_THRESHOLD_
 * MINUTES) raises exactly ONE operator alert, claimed through a
 * guarded `stuck_alerted_at` stamp on the job row (the
 * reapStaleRunning-style guarded-transition pattern on the async
 * job ports). The 2h reap stays the backstop and is untouched.
 *
 * Harness mirrors the #2358 characterization suites: real
 * node:sqlite behind the family's ports, rows seeded at controlled
 * ages (the seeded `started_at` is the test clock), an injected
 * notifyStuckRun spy standing in for the Slack delivery the class
 * wires in production.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";

import {
  ensureAsyncJobGraphColumns,
  getAsyncJob,
  type AsyncJobsContext,
  type StuckRunAlertInfo,
} from "../src/agents/orchestrator/asyncJobs";
import { resolveStuckRunAlertThresholdMs } from "../src/config/stuckRunAlert";

/** SqlStorage-shaped executor over node:sqlite (rowsWritten
 *  surfaced like the DO cursor — same shim as #2358). */
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

interface Harness {
  db: DatabaseSync;
  ctx: AsyncJobsContext;
  alerts: StuckRunAlertInfo[];
  audits: Array<{ type: string; payload: Record<string, unknown> }>;
}

function makeHarness(options: {
  env?: Record<string, string>;
  notify?: (info: StuckRunAlertInfo) => Promise<void>;
  withNotify?: boolean;
} = {}): Harness {
  const db = new DatabaseSync(":memory:");
  const sql = makeSql(db);
  const alerts: StuckRunAlertInfo[] = [];
  const audits: Harness["audits"] = [];
  const withNotify = options.withNotify !== false;
  const ctx = {
    env: options.env ?? {},
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
      throw new Error("no orm in stuck-alert harness");
    },
    ...(withNotify
      ? {
          notifyStuckRun: options.notify ?? (async (info: StuckRunAlertInfo) => {
            alerts.push(info);
          }),
        }
      : {}),
  } as unknown as AsyncJobsContext;
  return { db, ctx, alerts, audits };
}

function seedRunning(
  db: DatabaseSync,
  row: { jobId: string; startedAt: string; status?: string; capability?: string },
): void {
  ensureAsyncJobGraphColumns(makeSql(db) as never);
  db.prepare(
    "INSERT INTO mas_async_jobs (job_id, session_id, capability, display_name, status, payload_json, created_at, updated_at, started_at) VALUES (?, 'owner-login-1', ?, 'Seeded run', ?, '{}', ?, ?, ?)",
  ).run(
    row.jobId,
    row.capability ?? "screen.run",
    row.status ?? "running",
    row.startedAt,
    row.startedAt,
    row.startedAt,
  );
}

describe("stuck-running alert (#2567)", () => {
  it("a run aged past the default threshold emits exactly one alert across repeated reads", async () => {
    const h = makeHarness();
    seedRunning(h.db, { jobId: "job-stuck-1", startedAt: isoAgo(45 * MIN) });

    const first = getAsyncJob(h.ctx, "job-stuck-1");
    expect(first?.status).toBe("running");
    // Delivery is fire-and-forget off the sync read path.
    await vi.waitFor(() => expect(h.alerts).toHaveLength(1));
    expect(h.alerts[0].jobId).toBe("job-stuck-1");
    expect(h.alerts[0].capability).toBe("screen.run");
    expect(h.alerts[0].ownerLogin).toBe("owner-login-1");
    expect(h.alerts[0].ageMs).toBeGreaterThan(44 * MIN);
    expect(h.alerts[0].ageMs).toBeLessThan(46 * MIN);
    expect(h.alerts[0].thresholdMs).toBe(30 * MIN);

    // Repeated reads never re-alert: the claim is on the row.
    getAsyncJob(h.ctx, "job-stuck-1");
    getAsyncJob(h.ctx, "job-stuck-1");
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(1);
    expect(
      h.audits.filter((a) => a.type === "async_job.stuck_detected"),
    ).toHaveLength(1);
  });

  it("a young running job emits no alert", async () => {
    const h = makeHarness();
    seedRunning(h.db, { jobId: "job-young", startedAt: isoAgo(5 * MIN) });
    expect(getAsyncJob(h.ctx, "job-young")?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
  });

  it("completed and queued runs emit no alert however old", async () => {
    const h = makeHarness();
    seedRunning(h.db, { jobId: "job-done", startedAt: isoAgo(90 * MIN), status: "completed" });
    seedRunning(h.db, { jobId: "job-queued", startedAt: isoAgo(90 * MIN), status: "queued" });
    expect(getAsyncJob(h.ctx, "job-done")?.status).toBe("completed");
    expect(getAsyncJob(h.ctx, "job-queued")?.status).toBe("queued");
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
  });

  it("the threshold is configuration: a 1-minute threshold flags a 5-minute run; 0 disables", async () => {
    const strict = makeHarness({ env: { STUCK_RUN_ALERT_THRESHOLD_MINUTES: "1" } });
    seedRunning(strict.db, { jobId: "job-five-min", startedAt: isoAgo(5 * MIN) });
    getAsyncJob(strict.ctx, "job-five-min");
    await vi.waitFor(() => expect(strict.alerts).toHaveLength(1));
    expect(strict.alerts[0].thresholdMs).toBe(1 * MIN);

    const disabled = makeHarness({ env: { STUCK_RUN_ALERT_THRESHOLD_MINUTES: "0" } });
    seedRunning(disabled.db, { jobId: "job-ninety-min", startedAt: isoAgo(90 * MIN) });
    getAsyncJob(disabled.ctx, "job-ninety-min");
    await new Promise((r) => setTimeout(r, 25));
    expect(disabled.alerts).toHaveLength(0);
  });

  it("a delivery failure never breaks the read, and detection stays audited", async () => {
    const h = makeHarness({
      notify: async () => {
        throw new Error("slack down");
      },
    });
    seedRunning(h.db, { jobId: "job-unlucky", startedAt: isoAgo(45 * MIN) });
    expect(getAsyncJob(h.ctx, "job-unlucky")?.status).toBe("running");
    await new Promise((r) => setTimeout(r, 25));
    expect(
      h.audits.some((a) => a.type === "async_job.stuck_detected" && a.payload.jobId === "job-unlucky"),
    ).toBe(true);
    // Still exactly one claim even though delivery failed.
    getAsyncJob(h.ctx, "job-unlucky");
    await new Promise((r) => setTimeout(r, 25));
    expect(h.audits.filter((a) => a.type === "async_job.stuck_detected")).toHaveLength(1);
  });

  it("without a delivery hook wired, detection is still claimed + audited (never invisible)", async () => {
    const h = makeHarness({ withNotify: false });
    seedRunning(h.db, { jobId: "job-no-hook", startedAt: isoAgo(45 * MIN) });
    expect(getAsyncJob(h.ctx, "job-no-hook")?.status).toBe("running");
    expect(h.audits.some((a) => a.type === "async_job.stuck_detected")).toBe(true);
  });

  it("the 2h reap stays the backstop: a 3h-old run is reaped, not alerted", async () => {
    const h = makeHarness();
    seedRunning(h.db, { jobId: "job-ancient", startedAt: isoAgo(3 * 60 * MIN) });
    const reaped = getAsyncJob(h.ctx, "job-ancient");
    expect(reaped?.status).toBe("failed");
    await new Promise((r) => setTimeout(r, 25));
    expect(h.alerts).toHaveLength(0);
  });
});

describe("stuck-run threshold resolver (#2567)", () => {
  it("defaults to 30 minutes; parses minutes; 0 disables; garbage falls back", () => {
    expect(resolveStuckRunAlertThresholdMs({})).toBe(30 * MIN);
    expect(resolveStuckRunAlertThresholdMs({ STUCK_RUN_ALERT_THRESHOLD_MINUTES: "45" })).toBe(45 * MIN);
    expect(resolveStuckRunAlertThresholdMs({ STUCK_RUN_ALERT_THRESHOLD_MINUTES: "0" })).toBe(0);
    expect(resolveStuckRunAlertThresholdMs({ STUCK_RUN_ALERT_THRESHOLD_MINUTES: "-5" })).toBe(0);
    expect(resolveStuckRunAlertThresholdMs({ STUCK_RUN_ALERT_THRESHOLD_MINUTES: "soon" })).toBe(30 * MIN);
    expect(resolveStuckRunAlertThresholdMs({ STUCK_RUN_ALERT_THRESHOLD_MINUTES: "  " })).toBe(30 * MIN);
  });
});
