/**
 * Issue #1999 (Phase 4) — conformance pins for the stage-contract
 * remainder that tests/stage_contracts_1999.test.ts does not pin:
 *
 * - D5: the chain-bridge submission (goal + discovery) retries
 *   under the report policy (2 attempts) and, on final failure,
 *   audits `followup.schedule_failed` instead of silently assuming
 *   delivery from a kept canonical row.
 * - D8: audit vs telemetry on the goal path — stage audit records
 *   land in mas_events (orm.events), telemetry lands in the #1743
 *   Analytics Engine stream (env.OBSERVABILITY data points), and
 *   neither sink ever carries the other's records.
 * - D2: the third fixed site (screener failure-notify audit insert)
 *   warns on a lost insert; plus the dispositions register pin —
 *   tests/stage_contracts_d2_register_1999.json (the machine-
 *   readable form of the D2 record on #1999, comment 6478545249)
 *   must match the `Non-critical` swallow sites actually in src/,
 *   per file, shrink-only.
 */
import { describe, expect, it, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import { publishScreenerFailed } from "../src/events/screenerPublishers";
import type { ScreenerFailedEvent } from "../src/events/screenerEvents";
import type { Env } from "../src/types";
import type { GoalDrivenScreenResult } from "../src/services/goalDrivenScreen";
import { STOCK_SCREENING_PROVIDER_ID } from "../src/trading/screeningProvider";

const ROOT = path.resolve(__dirname, "..");

afterEach(() => {
  vi.restoreAllMocks();
});

function fakeGoalResult(overrides: Partial<GoalDrivenScreenResult> = {}): GoalDrivenScreenResult {
  return {
    goalKind: "income",
    outlook: "bullish",
    plan: {
      goalKind: "income",
      outlook: "bullish",
      structures: ["cash_secured_put"],
      stockFilter: {},
      optionsFilter: {},
    },
    status: "complete",
    hits: [
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "AAPL" },
      { assetClass: "stocks", providerId: STOCK_SCREENING_PROVIDER_ID, symbol: "MSFT" },
    ],
    counts: {
      stocksScanned: 100,
      stocksMatched: 2,
      optionsUnderlyingsScanned: 0,
      optionsContractsMatched: 0,
      hits: 2,
    },
    completedAt: "2026-10-27T12:00:00.000Z",
    ...overrides,
  } as GoalDrivenScreenResult;
}

/**
 * The #1996 harness shape (real ORM over mock SQL, audit replaced
 * with a recorder, guard + screener agent stubbed) so the chain
 * path runs its real code — only the bridge outcome varies.
 */
function goalService(opts: { followupScheduler?: unknown } = {}) {
  const mockEnv = {
    ETRADE_ENVIRONMENT: "sandbox",
    FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }),
  } as unknown as Env;
  const mockOrm = new DatabaseORM(new MockSqlStorage() as never);
  const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
  const audit = vi.fn((_type: string, _payload: Record<string, unknown>) => {});
  const guard = vi.fn(async () => ({ blocked: false as const }));
  const runGoalScreen = vi.fn(async (_req: Record<string, unknown>) => ({
    task: { id: "task-1", status: "completed" },
    executed: true,
    result: fakeGoalResult(),
    canonicalReportId: "report-1",
  }));
  (service as unknown as Record<string, unknown>).audit = audit;
  (service as unknown as Record<string, unknown>).guardScheduledAuth = guard;
  (service as unknown as Record<string, unknown>).getScreenerAgent = () => ({ runGoalScreen });
  if (opts.followupScheduler) {
    (service as unknown as Record<string, unknown>).followupScheduler = opts.followupScheduler;
  }
  return { service, audit, runGoalScreen };
}

function scheduleFailedCalls(audit: ReturnType<typeof vi.fn>) {
  return audit.mock.calls.filter((c) => c[0] === "followup.schedule_failed");
}

/* ------------------------------------------------------------------ */
/* D5 — chain-bridge retry + followup.schedule_failed audit            */
/* ------------------------------------------------------------------ */

describe("D5 chain-bridge retry (#1999)", () => {
  it("goal bridge: an always-failing bridge is retried under the report policy, then audited", async () => {
    // #3515 S3: the warn now travels as a structured
    // scheduledTasks.goal_bridge_failed event (level warn) on the
    // console-info JSON fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const bridge = vi.fn(async () => {
      throw new Error("bridge boom");
    });
    const { service, audit } = goalService({ followupScheduler: bridge });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      stageChain: {} as never,
    });
    // Report policy = 2 total attempts (pipelinePolicy retry.report).
    expect(bridge).toHaveBeenCalledTimes(2);
    // The screen outcome is kept; delivery is NOT claimed — the
    // failure is on the audit record instead.
    expect(result.success).toBe(true);
    const failed = scheduleFailedCalls(audit);
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ error: "bridge boom" });
    expect(String(failed[0][1].taskId ?? "")).not.toBe("");
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const bridgeFailed = events.find((e) => e.operation === "scheduledTasks.goal_bridge_failed");
    expect(bridgeFailed).toBeDefined();
    expect(bridgeFailed?.level).toBe("warn");
    expect(String(bridgeFailed?.fields.message ?? "")).toMatch(/Goal bridge failed \(canonical row kept\)/);
  });

  it("goal bridge: a bridge that fails once then succeeds is retried and NOT audited as failed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const bridge = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient bridge boom");
    });
    const { service, audit } = goalService({ followupScheduler: bridge });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      stageChain: {} as never,
    });
    expect(bridge).toHaveBeenCalledTimes(2);
    expect(result.success).toBe(true);
    expect(scheduleFailedCalls(audit)).toHaveLength(0);
  });

  it("goal bridge: a first-try success makes exactly one call and no failure audit", async () => {
    const bridge = vi.fn(async () => {});
    const { service, audit } = goalService({ followupScheduler: bridge });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      stageChain: {} as never,
    });
    expect(bridge).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
    expect(scheduleFailedCalls(audit)).toHaveLength(0);
  });

  it("discovery bridge: an always-failing bridge is retried under the report policy, then audited", async () => {
    // #3515 S3: the warn now travels as a structured
    // scheduledTasks.discovery_bridge_failed event (level warn) on the
    // console-info JSON fallback, not a console.warn line.
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
    const bridge = vi.fn(async () => {
      throw new Error("bridge boom");
    });
    const audit = vi.fn((_type: string, _payload: Record<string, unknown>) => {});
    // No ORM: the canonical-store leg is skipped, the bridge leg
    // is the whole remainder of the method.
    const service = new ScheduledTasksService(
      { ETRADE_ENVIRONMENT: "sandbox" } as unknown as Env,
      undefined as never,
      "test_trader",
    );
    (service as unknown as Record<string, unknown>).followupScheduler = bridge;
    (service as unknown as Record<string, unknown>).audit = audit;
    const persist = (
      service as unknown as {
        persistDiscoveryCanonicalAndBridge: (args: unknown) => Promise<string | undefined>;
      }
    ).persistDiscoveryCanonicalAndBridge.bind(service);
    const reportId = await persist({
      run: { id: "run-1", status: "complete", inputModel: "momentum" },
      summary: "discovery summary",
      symbols: ["AAA"],
      options: { stageChain: {}, trigger: "scheduled" },
      timestamp: "2026-10-29T00:00:00.000Z",
      outcomes: [],
      matchedCount: 0,
      totalScanned: 1,
    });
    expect(reportId).toBeUndefined();
    expect(bridge).toHaveBeenCalledTimes(2);
    const failed = scheduleFailedCalls(audit);
    expect(failed).toHaveLength(1);
    expect(failed[0][1]).toMatchObject({ bridge: "discovery", error: "bridge boom" });
    const events: Array<{ operation: string; level: string; fields: Record<string, unknown> }> = [];
    for (const call of infoSpy.mock.calls) {
      try {
        const parsed = JSON.parse(String(call[0])) as {
          operation?: unknown;
          level?: unknown;
          fields?: unknown;
        };
        if (parsed && typeof parsed.operation === "string") {
          events.push({
            operation: parsed.operation,
            level: typeof parsed.level === "string" ? parsed.level : "",
            fields:
              parsed.fields && typeof parsed.fields === "object"
                ? (parsed.fields as Record<string, unknown>)
                : {},
          });
        }
      } catch {
        // Non-JSON console.info lines are not structured events.
      }
    }
    const bridgeFailed = events.find((e) => e.operation === "scheduledTasks.discovery_bridge_failed");
    expect(bridgeFailed).toBeDefined();
    expect(bridgeFailed?.level).toBe("warn");
    expect(String(bridgeFailed?.fields.message ?? "")).toMatch(/Discovery bridge failed \(canonical row kept\)/);
  });
});

/* ------------------------------------------------------------------ */
/* D8 — audit (mas_events) vs telemetry (#1743 stream)                 */
/* ------------------------------------------------------------------ */

interface CapturedPoint {
  indexes?: string[];
  doubles?: number[];
  blobs?: string[];
}

function workflowGoalService(opts: { withBinding: boolean }) {
  const dataPoints: CapturedPoint[] = [];
  const binding = {
    create: vi.fn(async ({ id }: { id: string }) => ({ id })),
    get: vi.fn(async (id: string) => ({
      id,
      status: async () => ({ status: "queued" }),
    })),
  };
  const mockEnv = {
    ETRADE_ENVIRONMENT: "sandbox",
    FEATURE_FLAGS: JSON.stringify({ goal_workflow: true }),
    ...(opts.withBinding ? { SCREENER_WORKFLOW: binding } : {}),
    AGENT_DB: {},
    OBSERVABILITY: {
      writeDataPoint: (point: CapturedPoint) => {
        dataPoints.push(point);
      },
    },
  } as unknown as Env;
  const mockOrm = new DatabaseORM(new MockSqlStorage() as never);
  const auditRows: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const realCreate = mockOrm.events.create.bind(mockOrm.events);
  (mockOrm.events as unknown as Record<string, unknown>).create = (
    row: { type?: string; payload?: Record<string, unknown> },
  ) => {
    auditRows.push(row);
    return realCreate(row as never);
  };
  const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
  (service as unknown as Record<string, unknown>).guardScheduledAuth = vi.fn(
    async () => ({ blocked: false as const }),
  );
  return { service, dataPoints, auditRows };
}

describe("D8 audit vs telemetry on the goal path (#1999)", () => {
  it("a submitted run writes its audit row to mas_events and its start event to telemetry — never crossed", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, dataPoints, auditRows } = workflowGoalService({ withBinding: true });
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(true);
    expect((result as { data?: { status?: string } }).data?.status).toBe("queued");

    // Audit side: the submission is a mas_events row (system
    // principal, D7), and the telemetry operation name never
    // appears as an audit row type.
    const auditTypes = auditRows.map((r) => r.type);
    expect(auditTypes).toContain("goal_screen.workflow_submitted");
    expect(auditTypes).not.toContain("goal.workflow.start");
    const submitted = auditRows.find((r) => r.type === "goal_screen.workflow_submitted");
    expect(submitted?.payload).toMatchObject({ principalKind: "system" });

    // Telemetry side: exactly one data point — the start event,
    // counts/ids shape (type, level, operation, run id) — and it
    // is not an audit record (no audit payload rides the stream).
    expect(dataPoints).toHaveLength(1);
    const blobs = dataPoints[0].blobs ?? [];
    expect(blobs[0]).toBe("goal.workflow.start");
    expect(blobs[1]).toBe("info");
    expect(blobs[2]).toBe("goal.workflow.start");
    expect(blobs[3]).toBe((result as { data?: { taskId?: string } }).data?.taskId);
    expect(blobs.join(" ")).not.toMatch(/workflow_submitted/);
  });

  it("a failed start emits ONE telemetry error event (code, never an audit row for the telemetry op) and audits the run failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { service, dataPoints, auditRows } = workflowGoalService({ withBinding: false });
    const result = await service.autonomousGoalScreen({ goalKind: "income" });
    expect(result.success).toBe(false);

    // Telemetry: one error event carrying the stable code in the
    // error-code slot — codes/facts only, no raw message, and it
    // does not become a mas_events row.
    expect(dataPoints).toHaveLength(1);
    const blobs = dataPoints[0].blobs ?? [];
    expect(blobs[0]).toBe("goal.workflow.start");
    expect(blobs[1]).toBe("error");
    expect(blobs[6]).toBe("workflow_binding_absent");

    // Audit: the run failure IS an audit-path event and is
    // recorded as one; the telemetry op is not.
    const auditTypes = auditRows.map((r) => r.type);
    expect(auditTypes).toContain("goal_screen.run_failed");
    expect(auditTypes).not.toContain("goal.workflow.start");
  });
});

/* ------------------------------------------------------------------ */
/* D2 fixed site 3 — screener failure-notify audit insert              */
/* ------------------------------------------------------------------ */

describe("D2 fixed site: failure-notify audit insert (#1999)", () => {
  const failedEvent: ScreenerFailedEvent = {
    type: "screener.failed",
    timestamp: "2026-10-29T00:00:00.000Z",
    sector: "TECH",
    universe: "TECH",
    error: "screen boom",
    trigger: "scheduled",
  };

  it("a lost failure-notify audit insert warns with type + login (#1999 D2)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const orm = {
      events: {
        create: () => {
          throw new Error("db down");
        },
      },
    };
    // No channel configured anywhere (bare env, no event targets)
    // → the skip itself is audited; the insert throws.
    await publishScreenerFailed(
      { env: {} as Env, orm: orm as never, userLogin: "alice" },
      failedEvent,
    );
    const text = warn.mock.calls.map((c) => c.map(String).join(" ")).join("\n");
    expect(text).toMatch(/screener\.failure_notify_skipped/);
    expect(text).toMatch(/alice/);
  });

  it("a stored failure-notify audit insert records the skip (#1999 D2)", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const rows: Array<{ type?: string; sessionId?: string }> = [];
    const orm = {
      events: {
        create: (row: { type?: string; sessionId?: string }) => {
          rows.push(row);
        },
      },
    };
    await publishScreenerFailed(
      { env: {} as Env, orm: orm as never, userLogin: "alice" },
      failedEvent,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("screener.failure_notify_skipped");
    expect(rows[0].sessionId).toBe("alice");
  });
});

/* ------------------------------------------------------------------ */
/* D2 dispositions register pin                                        */
/* ------------------------------------------------------------------ */

interface RegisterEntry {
  id: string;
  file: string;
  classification: "fixed" | "accepted" | "follow_up" | "out_of_scope";
  family?: string;
  lineAtRegistration?: number | null;
  followUp?: string;
  honestyTests?: Array<{ file: string; title: string }>;
}

interface Register {
  marker: string;
  entries: RegisterEntry[];
}

function scanNonCriticalMarkers(): Map<string, number[]> {
  const srcRoot = path.join(ROOT, "src");
  const found = new Map<string, number[]>();
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry.name)) {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((line, idx) => {
          if (line.includes("Non-critical")) {
            const rel = path.relative(ROOT, full);
            const arr = found.get(rel) ?? [];
            arr.push(idx + 1);
            found.set(rel, arr);
          }
        });
      }
    }
  };
  walk(srcRoot);
  return found;
}

describe("D2 dispositions register (#1999)", () => {
  const register = JSON.parse(
    fs.readFileSync(path.join(ROOT, "tests", "stage_contracts_d2_register_1999.json"), "utf8"),
  ) as Register;
  const scanned = scanNonCriticalMarkers();
  const markerEntries = register.entries.filter(
    (e) => e.classification === "accepted" || e.classification === "follow_up" || e.classification === "out_of_scope",
  );

  it("the register carries the dispositioned shape: 4 fixed + 28 accepted (= 32), no tracked follow-up (#2165 fixed)", () => {
    const fixed = register.entries.filter((e) => e.classification === "fixed");
    const accepted = register.entries.filter((e) => e.classification === "accepted");
    const followUp = register.entries.filter((e) => e.classification === "follow_up");
    expect(fixed).toHaveLength(4);
    expect(accepted).toHaveLength(28);
    expect(fixed.length + accepted.length).toBe(32);
    expect(followUp).toHaveLength(0);
    // Accepted families match the source record's split.
    expect(accepted.filter((e) => e.family === "message_record")).toHaveLength(18);
    expect(accepted.filter((e) => e.family === "broadcast")).toHaveLength(8);
    expect(accepted.filter((e) => e.family === "other")).toHaveLength(2);
  });

  it("every Non-critical site in src/ is registered, per file — no unregistered swallow, none missing (shrink-only)", () => {
    const registeredByFile = new Map<string, number>();
    for (const e of markerEntries) {
      registeredByFile.set(e.file, (registeredByFile.get(e.file) ?? 0) + 1);
    }
    // Same file set, same counts.
    expect([...registeredByFile.keys()].sort()).toEqual([...scanned.keys()].sort());
    for (const [file, lines] of scanned) {
      expect(registeredByFile.get(file), file).toBe(lines.length);
    }
    const scannedTotal = [...scanned.values()].reduce((n, arr) => n + arr.length, 0);
    expect(scannedTotal).toBe(markerEntries.length);
    // Every registered site names the line it was registered at.
    for (const e of markerEntries) {
      expect(typeof e.lineAtRegistration, e.id).toBe("number");
    }
  });

  it("every fixed site names a live honesty test, and every register entry names a real file", () => {
    for (const e of register.entries) {
      expect(fs.existsSync(path.join(ROOT, e.file)), e.id).toBe(true);
    }
    const fixed = register.entries.filter((e) => e.classification === "fixed");
    for (const e of fixed) {
      expect(e.honestyTests?.length ?? 0, e.id).toBeGreaterThan(0);
      for (const t of e.honestyTests ?? []) {
        const content = fs.readFileSync(path.join(ROOT, t.file), "utf8");
        expect(content, `${e.id} → ${t.file}`).toContain(t.title);
      }
    }
  });
});
