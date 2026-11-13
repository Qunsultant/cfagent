/**
 * Issue #4280 ([One engine] #3550 S5) — scheduled sharded chain onto the engine.
 *
 * What is pinned here:
 *  - Submit-only seam entry: `submitStockScreenViaEngine` runs the seam's
 *    gates (ND backstop, in-flight probe, quota) + start exactly once and
 *    returns `{ jobId, workflowId }` WITHOUT awaiting — the chain's contract
 *    is submit-and-return (queued + chainId), and the tick must not block
 *    up to 10 min awaiting an ALL-universe run. The await variant
 *    (`runStockScreenViaEngine`) still polls to its deadline (regression).
 *  - Channel plumbing: the workflow command carries the per-request
 *    delivery envelope (`delivery`) and the stage-chain config
 *    (`stageChain`) — spec -> command -> job-definition params -> shard
 *    commands (spread). An empty delivery is omitted (the S3
 *    exact-equality pins). This implements #4300's outcome for all stock
 *    entries, not just scheduled.
 *  - Stage-chain delay mechanics: a chained outcome's report job is stage
 *    `serve` with `runAt = now + serveDelaySeconds` under the run's chain
 *    id; `recordScreenerRunMainJob` uses a caller-supplied chain id
 *    (the engine job id) instead of minting a fresh UUID — one run, one
 *    group key in Workflow Runs. Without a supplied id it still mints
 *    fresh (existing behavior preserved).
 *  - Door overlay (`overlayEngineDelivery`, pure): the delivery envelope
 *    lands on the run outcome only where the outcome lacks it (a
 *    payload-stamped value wins); `stageChain` is stamped.
 *  - Goal chain-mode: `buildGoalScreenCommand` carries `stageChain` +
 *    `slackChannel`; a chain-mode scheduled goal screen submits the goal
 *    workflow (a failed start fails the tick, never a silent direct
 *    fallback); no `executeGoalScreenRun` remains in `autonomousGoalScreen`.
 *  - Market sharded submit through the seam: the scheduled service submits
 *    via `submitStockScreenViaEngine` with `jobId == chainId`, the delivery
 *    envelope, and `stageChain`; the lock + active-chain probes still gate
 *    first, fail-closed; a seam rejection runs the #1851 failure path.
 *  - No live chain calls: `startScheduledShardedChain` lives only in its
 *    `.deprecated.ts` module (plus tests); `scheduledTasks.ts` and
 *    `screenExecutionBroker.ts` contain no reference to it.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  runStockScreenViaEngine,
  submitStockScreenViaEngine,
} from "../src/workflows/runStockScreenViaEngine";
import {
  buildParentScreenCommand,
  buildStockScreenWorkflowCommand,
} from "../src/workflows/screenExecutionBroker";
import {
  buildScreenerJobDefinition,
  overlayEngineDelivery,
} from "../src/services/screenerPipelineJobs";
import { shardCommandFor } from "../src/workflows/screenerCollation";
import {
  planInitialFollowups,
  resolveScreenerFollowupConfig,
  type ScreenerRunOutcome,
} from "../src/services/screenerFollowups";
import {
  recordScreenerRunMainJob,
  type AsyncJobsContext,
} from "../src/agents/orchestrator/asyncJobs";
import { buildGoalScreenCommand } from "../src/services/goalScreenWorkflowSubmission";
import { ScheduledTasksService } from "../src/services/scheduledTasks";
import { DatabaseORM } from "../src/orm";
import { MockSqlStorage } from "./mock-sql";
import type { Env } from "../src/types";
import type { WorkflowJobCommand } from "../src/workflows/workflowPorts";
import { ScreenAlreadyRunningError } from "../src/services/screenInFlight";
import { WorkflowError } from "../src/workflows/workflowPorts";

const read = (p: string) => readFileSync(join("src", p), "utf8");

/* ------------------------------------------------------------------ */
/* Submit-seam harness (mirrors the S3 seam harness)                   */
/* ------------------------------------------------------------------ */

interface SubmitHarness {
  started: WorkflowJobCommand[];
  startCalls: number;
  statusCalls: number;
  historyCalls: number;
  charges: Array<{ userLogin: string; runId: string }>;
  probes: Array<{ userLogin: string; universe: string }>;
  port: {
    start: (command: unknown) => Promise<unknown>;
    status: (...args: unknown[]) => Promise<unknown>;
  };
  opts: {
    probeRunning?: { startedAt: number; runId: string };
    chargeThrows?: Error;
    startThrows?: Error;
    portNull?: boolean;
  };
}

function makeSubmitHarness(opts: SubmitHarness["opts"] = {}): SubmitHarness {
  const harness: SubmitHarness = {
    started: [],
    startCalls: 0,
    statusCalls: 0,
    historyCalls: 0,
    charges: [],
    probes: [],
    port: {
      start: async (command: unknown) => {
        if (opts.startThrows) throw opts.startThrows;
        harness.startCalls += 1;
        harness.started.push(command as WorkflowJobCommand);
        return {
          workflowId: `wf-${(command as WorkflowJobCommand).jobId}`,
          jobId: (command as WorkflowJobCommand).jobId,
          status: "queued" as const,
          existing: false,
          statusUrl: `/api/jobs/history?chainId=${encodeURIComponent((command as WorkflowJobCommand).jobId)}`,
        };
      },
      status: async () => {
        harness.statusCalls += 1;
        return { workflowId: "wf-1", status: "running" };
      },
    },
    opts,
  };
  return harness;
}

function submitInput(harness: SubmitHarness, overrides: Record<string, unknown> = {}) {
  return {
    env: {} as never,
    spec: {
      source: "scheduled" as const,
      trigger: "scheduled" as const,
      deliver: true,
      filters: {},
      universe: "TECH",
      asyncRequested: false,
      delivery: {},
      userLogin: "alice",
    },
    userLogin: "alice",
    agent: {
      isScreenRunning: async (universe: string, userLogin: string) => {
        harness.probes.push({ userLogin, universe });
        if (harness.opts.probeRunning) {
          return {
            running: true,
            startedAt: harness.opts.probeRunning.startedAt,
            runId: harness.opts.probeRunning.runId,
            status: "running" as const,
          };
        }
        return { running: false, startedAt: null, runId: null, status: "idle" as const };
      },
      chargeScreenQuota: async (input: { userLogin: string; runId: string }) => {
        if (harness.opts.chargeThrows) throw harness.opts.chargeThrows;
        harness.charges.push(input);
      },
      getHistory: async () => [],
    },
    ...(harness.opts.portNull ? { workflowPort: null } : { workflowPort: harness.port as never }),
    readWorkflowJobHistory: async () => {
      harness.historyCalls += 1;
      return null as never;
    },
    sleep: async () => {},
    nowMs: () => 1_000_000,
    awaitDeadlineMs: 600_000,
    pollIntervalMs: 1,
    ...overrides,
  } as never;
}

/* ------------------------------------------------------------------ */
/* Submit-only seam                                                    */
/* ------------------------------------------------------------------ */

describe("submit-only seam (#4280)", () => {
  it("starts once with jobId == the override chain id and returns without awaiting", async () => {
    const harness = makeSubmitHarness();
    const out = await submitStockScreenViaEngine(
      submitInput(harness, {
        commandOverrides: { jobId: "chain-9" },
      }),
    );
    expect(harness.startCalls).toBe(1);
    expect(harness.started[0].jobId).toBe("chain-9");
    expect(out).toEqual({ jobId: "chain-9", workflowId: "wf-chain-9" });
    // No polling: the submit returns while the workflow is still running.
    expect(harness.statusCalls).toBe(0);
    expect(harness.historyCalls).toBe(0);
    expect(harness.probes).toHaveLength(1);
    expect(harness.charges).toHaveLength(1);
    expect(harness.charges[0].runId).toBe("chain-9:TECH");
  });

  it("refuses before start when a shard universe is already running (gate 2)", async () => {
    const harness = makeSubmitHarness({
      probeRunning: { startedAt: 999_000, runId: "screen:alice:TECH:999000" },
    });
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toBeInstanceOf(
      ScreenAlreadyRunningError,
    );
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toThrow(
      "already running",
    );
    expect(harness.startCalls).toBe(0);
  });

  it("refuses before start when quota refuses (gate 3)", async () => {
    const harness = makeSubmitHarness({ chargeThrows: new Error("quota exhausted") });
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toThrow(
      "quota exhausted",
    );
    expect(harness.startCalls).toBe(0);
  });

  it("refuses with a coded unavailable error when the workflow port cannot be built", async () => {
    const harness = makeSubmitHarness({ portNull: true });
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toBeInstanceOf(
      WorkflowError,
    );
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toThrow("unavailable");
    expect(harness.startCalls).toBe(0);
  });

  it("a start failure throws start_failed with no fallback run", async () => {
    const harness = makeSubmitHarness({ startThrows: new Error("binding boom") });
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toBeInstanceOf(
      WorkflowError,
    );
    // The code rides WorkflowError.code (the repo's coded-error
    // convention), not the message — assert the field, not a
    // substring of the human-readable text.
    await expect(submitStockScreenViaEngine(submitInput(harness))).rejects.toMatchObject({
      code: "start_failed",
    });
  });

  it("the await variant still polls to its deadline (regression: submit did not change await)", async () => {
    const harness = makeSubmitHarness();
    const jobId = "screener:manual:TECH:2026-11-12T10:00:00.000Z";
    let now = 1_000_000;
    const out = await runStockScreenViaEngine(
      submitInput(harness, {
        spec: {
          source: "etrade",
          trigger: "manual",
          deliver: true,
          filters: {},
          universe: "TECH",
          asyncRequested: false,
          delivery: {},
          userLogin: "alice",
          jobId,
        },
        nowMs: () => {
          now += 300_000;
          return now;
        },
        awaitDeadlineMs: 600_000,
        sleep: async () => {},
      }),
    );
    expect(harness.startCalls).toBe(1);
    expect(harness.statusCalls).toBeGreaterThan(0);
    expect(out.results[0].success).toBe(false);
    expect(out.results[0].error).toContain("did not complete within the engine await window");
  });
});

/* ------------------------------------------------------------------ */
/* Command carries delivery + stageChain                               */
/* ------------------------------------------------------------------ */

describe("command carries delivery + stageChain (#4280)", () => {
  const delivery = {
    emailTo: "ops@example.com",
    pushToSlack: true,
    slackChannel: "#screener",
    webhookUrl: "https://example.test/hook",
  };
  const stageChain = { serveDelaySeconds: 120, deliverDelaySeconds: 3600 };

  it("buildStockScreenWorkflowCommand copies delivery (defined fields) + stageChain", () => {
    const command = buildStockScreenWorkflowCommand(
      {
        source: "scheduled",
        trigger: "scheduled",
        deliver: true,
        filters: {},
        universe: "TECH",
        asyncRequested: false,
        delivery,
        stageChain,
        userLogin: "alice",
      } as never,
      { userLogin: "alice", tenantId: "tenant-1" },
    );
    expect(command.delivery).toEqual(delivery);
    expect(command.stageChain).toEqual(stageChain);
    expect(command.deliver).toBe(true);
  });

  it("buildStockScreenWorkflowCommand omits an empty delivery and an absent stageChain", () => {
    const command = buildStockScreenWorkflowCommand(
      {
        source: "scheduled",
        trigger: "scheduled",
        deliver: false,
        filters: {},
        universe: "TECH",
        asyncRequested: false,
        delivery: {},
        userLogin: "alice",
      } as never,
      { userLogin: "alice", tenantId: "tenant-1" },
    );
    expect("delivery" in command).toBe(false);
    expect("stageChain" in command).toBe(false);
  });

  it("buildParentScreenCommand carries both fields through", () => {
    const command = buildParentScreenCommand({
      jobId: "screener:scheduled:TECH:2026-11-12T10:00:00.000Z",
      source: "scheduled-tasks",
      trigger: "scheduled",
      userLogin: "alice",
      tenantId: "tenant-1",
      shards: [{ shardId: "TECH", universe: "TECH" }],
      filters: {},
      deliver: true,
      delivery,
      stageChain,
    });
    expect(command.delivery).toEqual(delivery);
    expect(command.stageChain).toEqual(stageChain);
  });

  it("buildScreenerJobDefinition puts both fields on every node's step params", () => {
    const command = buildStockScreenWorkflowCommand(
      {
        source: "scheduled",
        trigger: "scheduled",
        deliver: true,
        filters: {},
        universe: "TECH",
        asyncRequested: false,
        delivery,
        stageChain,
        userLogin: "alice",
      } as never,
      { userLogin: "alice", tenantId: "tenant-1" },
    );
    const def = buildScreenerJobDefinition(command) as {
      root: {
        steps: Array<{ params: Record<string, unknown> }>;
        children?: Array<{ steps: Array<{ params: Record<string, unknown> }>; children?: unknown }>;
      };
    };
    const paramsList: Array<Record<string, unknown>> = [];
    let node: typeof def.root | undefined = def.root;
    while (node) {
      expect(node.steps).toHaveLength(1);
      paramsList.push(node.steps[0].params);
      const children = (node as { children?: Array<typeof def.root> }).children;
      node = children?.[0];
    }
    expect(paramsList).toHaveLength(6);
    for (const params of paramsList) {
      expect(params.delivery).toEqual(delivery);
      expect(params.stageChain).toEqual(stageChain);
      expect(params.deliver).toBe(true);
    }
  });

  it("shardCommandFor spreads both fields to the shard command", () => {
    const parent = buildStockScreenWorkflowCommand(
      {
        source: "scheduled",
        trigger: "scheduled",
        deliver: true,
        filters: {},
        universe: "TECH",
        asyncRequested: false,
        delivery,
        stageChain,
        userLogin: "alice",
      } as never,
      { userLogin: "alice", tenantId: "tenant-1" },
    );
    const shard = shardCommandFor(parent, parent.shards[0]);
    expect(shard.delivery).toEqual(delivery);
    expect(shard.stageChain).toEqual(stageChain);
    expect(shard.role).toBe("shard");
    expect(shard.parentJobId).toBe(parent.jobId);
  });
});

/* ------------------------------------------------------------------ */
/* Stage-chain delay mechanics                                         */
/* ------------------------------------------------------------------ */

const followupConfig = resolveScreenerFollowupConfig({
  SLACK_WEBHOOK_URL: "https://hooks.slack.com/x",
  SCREENER_EMAIL_TO: "ops@example.com",
});

const plainOutcome: ScreenerRunOutcome = {
  kind: "stock",
  trigger: "scheduled",
  success: true,
  pdfKeys: ["k1"],
  pdfStatus: "generated",
  matchedCount: 2,
  totalScanned: 50,
  universe: "NASDAQ100",
  reportUrl: "/api/screener/report.pdf?key=k1",
};

const chainConfig = { serveDelaySeconds: 120, deliverDelaySeconds: 3600 };
const chainedOutcome: ScreenerRunOutcome = { ...plainOutcome, stageChain: chainConfig };

describe("stage-chain delay mechanics (#4280)", () => {
  it("plans the report job as stage serve with the chain id and runAt = now + serveDelaySeconds", () => {
    const nowIso = "2026-11-12T00:00:00.000Z";
    const specs = planInitialFollowups(chainedOutcome, followupConfig, "main-1", "alice", {
      chainId: "chain-1",
      nowIso,
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].stage).toBe("serve");
    expect(specs[0].chainId).toBe("chain-1");
    expect(specs[0].runAt).toBe("2026-11-12T00:02:00.000Z");
    const payload = specs[0].payload as { stageChain?: unknown; chainId?: unknown };
    expect(payload.stageChain).toEqual(chainConfig);
    expect(payload.chainId).toBe("chain-1");
  });

  it("plans the legacy immediate report job when the outcome carries no stageChain", () => {
    const specs = planInitialFollowups(plainOutcome, followupConfig, "main-1", "alice", {
      chainId: "chain-1",
      nowIso: "2026-11-12T00:00:00.000Z",
    });
    expect(specs).toHaveLength(1);
    expect(specs[0]).not.toHaveProperty("chainId");
    expect(specs[0]).not.toHaveProperty("runAt");
  });
});

/* Compact fake SQL + ctx for recordScreenerRunMainJob (modeled on the
 * C3 suite's harness: generic INSERT/SELECT/UPDATE over in-memory tables). */
type FakeRow = Record<string, unknown>;

class FakeSql4280 {
  tables: Record<string, FakeRow[]> = { mas_async_jobs: [], mas_screening_activity: [] };

  exec(query: string, ...args: unknown[]): { rowsWritten: number } & Iterable<FakeRow> {
    const q = query.trim().replace(/\s+/g, " ");
    const wrap = (rows: FakeRow[], rowsWritten = 0) => Object.assign(rows, { rowsWritten });
    if (/^CREATE TABLE|^CREATE INDEX|^PRAGMA|^ALTER/i.test(q)) return wrap([]);
    const tableMatch = q.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/i);
    const table = tableMatch?.[1] ?? "";
    if (/^DELETE FROM/i.test(q)) return wrap([]);
    if (/^INSERT INTO/i.test(q)) {
      const cols = q.match(/\(([^)]+)\)/)![1].split(",").map((c) => c.trim());
      const tokens = q.match(/VALUES \(([^)]+)\)/i)![1].split(",").map((c) => c.trim());
      const row: FakeRow = {};
      let ai = 0;
      cols.forEach((col, i) => {
        row[col] = tokens[i] === "?" ? (args[ai++] ?? null) : tokens[i].replace(/^'|'$/g, "");
      });
      (this.tables[table] ??= []).push(row);
      return wrap([], 1);
    }
    if (/^UPDATE/i.test(q)) {
      const setPart = q.match(/SET (.+?) WHERE/i)?.[1] ?? "";
      const assigns = setPart.split(",").map((s) => s.trim()).filter(Boolean);
      const wherePart = q.split(/ WHERE /i)[1] ?? "";
      let ai = 0;
      const conds: Array<[string, unknown]> = [];
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) conds.push([m[1], m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "")]);
      }
      let written = 0;
      for (const row of this.tables[table] ?? []) {
        if (conds.every(([c, v]) => row[c] === v)) {
          for (const a of assigns) {
            const eq = a.indexOf("=");
            const col = a.slice(0, eq).trim();
            const expr = a.slice(eq + 1).trim();
            row[col] = expr === "?" ? args[ai++] : expr.replace(/^'|'$/g, "");
          }
          written += 1;
        }
      }
      return wrap([], written);
    }
    if (/^SELECT/i.test(q)) {
      const listMatch = q.match(/SELECT (.+?) FROM (\w+)/i);
      if (!listMatch) return wrap([]);
      const cols = listMatch[1].split(",").map((c) => c.trim());
      let rows = [...(this.tables[listMatch[2]] ?? [])];
      const wherePart = (q.split(/ WHERE /i)[1] ?? "").split(/ ORDER BY /i)[0];
      let ai = 0;
      for (const cond of wherePart.split(/ AND /i)) {
        const m = cond.trim().match(/^(\w+)\s*=\s*(\?|'[^']*')$/);
        if (m) {
          const val = m[2] === "?" ? args[ai++] : m[2].replace(/^'|'$/g, "");
          rows = rows.filter((r) => r[m[1]] === val);
        }
      }
      if (/ORDER BY created_at DESC/i.test(q)) {
        rows.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      }
      if (/ORDER BY created_at ASC/i.test(q)) {
        rows.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      }
      const limitMatch = q.match(/LIMIT (\?|\d+)/i);
      if (limitMatch) {
        const n = limitMatch[1] === "?" ? Number(args[ai++]) : Number(limitMatch[1]);
        if (Number.isFinite(n)) rows = rows.slice(0, n);
      }
      return wrap(
        rows.map((row) => {
          const out: FakeRow = {};
          for (const col of cols) out[col] = row[col] ?? null;
          return out;
        }),
      );
    }
    throw new Error(`FakeSql4280: unsupported: ${q.slice(0, 90)}`);
  }

  rows(table: string): FakeRow[] {
    return this.tables[table] ?? [];
  }
}

function makeBridgeCtx(sql: FakeSql4280): AsyncJobsContext {
  const storage = sql as unknown as AsyncJobsContext["agentCtx"]["storage"]["sql"];
  return {
    env: { SLACK_WEBHOOK_URL: "https://hooks.slack.com/x", SCREENER_EMAIL_TO: "ops@example.com" },
    agentCtx: { storage: { sql: storage } },
    ensureTables: () => storage,
    sessionKey: () => "session-1",
    schedule: async () => ({}),
    audit: () => {},
    getOrm: () => ({ events: { create: () => ({}) } }),
    routeRequest: async () => new Response("{}", { status: 200 }),
    nlqSchedulingPort: () => {
      throw new Error("unused");
    },
    nlqStockScreenPort: () => {
      throw new Error("unused");
    },
    followupReportPort: () => ({
      getStockPdf: async (_u: string, key: string) =>
        key === "k1" ? { fileName: "screen.pdf" } : null,
      getOptionsPdf: async () => null,
    }),
    followupDeliveryPort: () => ({
      deliver: async () => ({ ok: true, detail: "sent-1" }),
      notify: async () => ({ ok: true }),
    }),
    reportDispatchHitlEnabled: () => false,
    createScreenerConfirmation: () => "rc_unused",
  } as unknown as AsyncJobsContext;
}

describe("recordScreenerRunMainJob chain id (#4280)", () => {
  it("uses the caller-supplied chain id for the main job and its serve followup", async () => {
    const sql = new FakeSql4280();
    const ctx = makeBridgeCtx(sql);
    const before = Date.now();
    await recordScreenerRunMainJob(ctx, chainedOutcome, "alice", { chainId: "chain-9" });
    const jobs = sql.rows("mas_async_jobs");
    const main = jobs.find((r) => r.capability === "screener.run");
    expect(main).toBeDefined();
    expect(main!.chain_id).toBe("chain-9");
    expect(main!.stage).toBe("generate");
    const report = jobs.find((r) => r.capability === "followup.report");
    expect(report).toBeDefined();
    expect(report!.chain_id).toBe("chain-9");
    expect(report!.stage).toBe("serve");
    const notBefore = Date.parse(String(report!.not_before ?? report!.run_at ?? ""));
    expect(notBefore).toBeGreaterThanOrEqual(before + 115_000);
    expect(notBefore).toBeLessThanOrEqual(Date.now() + 125_000);
  });

  it("mints a fresh chain id when none is supplied (existing behavior preserved)", async () => {
    const sql = new FakeSql4280();
    const ctx = makeBridgeCtx(sql);
    await recordScreenerRunMainJob(ctx, chainedOutcome, "alice");
    const jobs = sql.rows("mas_async_jobs");
    const main = jobs.find((r) => r.capability === "screener.run");
    const report = jobs.find((r) => r.capability === "followup.report");
    expect(typeof main!.chain_id).toBe("string");
    expect(String(main!.chain_id).length).toBeGreaterThan(0);
    expect(report!.chain_id).toBe(main!.chain_id);
  });

  it("stamps no chain id when the outcome carries no stageChain", async () => {
    const sql = new FakeSql4280();
    const ctx = makeBridgeCtx(sql);
    await recordScreenerRunMainJob(ctx, plainOutcome, "alice", { chainId: "chain-9" });
    const jobs = sql.rows("mas_async_jobs");
    const main = jobs.find((r) => r.capability === "screener.run");
    expect(main!.chain_id).toBeNull();
    expect(jobs.find((r) => r.capability === "followup.report")).toBeDefined();
    expect(jobs.find((r) => r.capability === "followup.report")!.chain_id).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Door overlay (pure)                                                 */
/* ------------------------------------------------------------------ */

describe("door overlay (#4280)", () => {
  const envelope = {
    emailTo: "ops@example.com",
    pushToSlack: true,
    slackChannel: "#screener",
    webhookUrl: "https://example.test/hook",
  };

  it("lands the envelope on the outcome and stamps the stageChain", () => {
    const out = overlayEngineDelivery(plainOutcome, envelope, chainConfig);
    expect(out.emailTo).toBe("ops@example.com");
    expect(out.slackChannel).toBe("#screener");
    expect(out.webhookUrl).toBe("https://example.test/hook");
    expect(out.deliveryChannels).toEqual(["email", "slack", "webhook"]);
    expect(out.stageChain).toEqual(chainConfig);
    expect(out.kind).toBe("stock");
    expect(out.matchedCount).toBe(2);
  });

  it("derives the channel allowlist from the envelope (no email, no slack when unrequested)", () => {
    const out = overlayEngineDelivery(plainOutcome, { webhookUrl: "https://example.test/hook" }, undefined);
    expect(out.deliveryChannels).toEqual(["webhook"]);
    expect(out.emailTo).toBeUndefined();
    expect(out.slackChannel).toBeUndefined();
    expect(out.stageChain).toBeUndefined();
  });

  it("pushToSlack false plans no slack channel", () => {
    const out = overlayEngineDelivery(
      plainOutcome,
      { emailTo: "ops@example.com", pushToSlack: false },
      undefined,
    );
    expect(out.deliveryChannels).toEqual(["email"]);
  });

  it("a payload-stamped value wins over the envelope", () => {
    const stamped: ScreenerRunOutcome = { ...plainOutcome, emailTo: "stored@example.com" };
    const out = overlayEngineDelivery(stamped, envelope, undefined);
    expect(out.emailTo).toBe("stored@example.com");
    expect(out.slackChannel).toBe("#screener");
  });

  it("no envelope and no stageChain leaves the outcome unchanged", () => {
    const out = overlayEngineDelivery(plainOutcome, undefined, undefined);
    expect(out).toEqual(plainOutcome);
  });
});

/* ------------------------------------------------------------------ */
/* Goal command carries stageChain + slackChannel                     */
/* ------------------------------------------------------------------ */

describe("goal command carries stageChain + slackChannel (#4280)", () => {
  const scenario = { goalKind: "income" } as never;

  it("copies stageChain and slackChannel into goalScreen", () => {
    const command = buildGoalScreenCommand({
      jobId: "goal-screen:scheduled:alice:income:2026-11-12T10:00",
      source: "scheduled-tasks",
      trigger: "scheduled",
      userLogin: "alice",
      tenantId: "tenant-1",
      scenario,
      scenarioSource: "built",
      deliverChannels: ["email", "slack"],
      emailTo: "ops@example.com",
      slackChannel: "#screener",
      stageChain: chainConfig,
    });
    expect(command.goalScreen!.stageChain).toEqual(chainConfig);
    expect(command.goalScreen!.slackChannel).toBe("#screener");
    expect(command.goalScreen!.deliver).toEqual(["email", "slack"]);
    expect(command.goalScreen!.emailTo).toBe("ops@example.com");
    expect(command.deliver).toBe(true);
  });

  it("omits both when absent (degenerate case)", () => {
    const command = buildGoalScreenCommand({
      jobId: "goal-screen:scheduled:alice:income:2026-11-12T10:00",
      source: "scheduled-tasks",
      trigger: "scheduled",
      userLogin: "alice",
      tenantId: "tenant-1",
      scenario,
      scenarioSource: "built",
    });
    expect("stageChain" in command.goalScreen!).toBe(false);
    expect("slackChannel" in command.goalScreen!).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* Goal chain-mode submits the workflow (service level)                */
/* ------------------------------------------------------------------ */

describe("goal chain-mode submits the workflow (#4280)", () => {
  function goalService(env: Record<string, unknown>) {
    const mockEnv = { ETRADE_ENVIRONMENT: "sandbox", ...env } as unknown as Env;
    const mockOrm = new DatabaseORM(new MockSqlStorage() as any);
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const audit = vi.fn(() => {});
    const guard = vi.fn(async () => ({ blocked: false as const }));
    const runGoalScreen = vi.fn(async () => ({ executed: true, result: { status: "complete" } }));
    (service as unknown as Record<string, unknown>).audit = audit;
    (service as unknown as Record<string, unknown>).guardScheduledAuth = guard;
    (service as unknown as Record<string, unknown>).getScreenerAgent = () => ({ runGoalScreen });
    return { service, audit, runGoalScreen };
  }

  it("chain-mode with no workflow binding fails the tick — the direct path never runs", async () => {
    const { service, audit, runGoalScreen } = goalService({
      FEATURE_FLAGS: JSON.stringify({}),
    });
    const result = await service.autonomousGoalScreen({
      goalKind: "income",
      stageChain: { serveDelaySeconds: 60, deliverDelaySeconds: 3600 },
    });
    expect(result.success).toBe(false);
    expect(runGoalScreen).not.toHaveBeenCalled();
    expect(audit.mock.calls.find((c) => c[0] === "goal_screen.run_failed")).toBeDefined();
  });

  it("no executeGoalScreenRun remains in autonomousGoalScreen", () => {
    const src = read("services/scheduledTasks.ts");
    const start = src.indexOf("async autonomousGoalScreen");
    const end = src.indexOf("async autonomousOptionsAnalysis", start);
    const body = src.slice(start, end === -1 ? undefined : end);
    expect(body).not.toContain("executeGoalScreenRun");
    expect(body).not.toContain("skipped_chain_mode");
  });
});

/* ------------------------------------------------------------------ */
/* Market sharded submit through the seam (service level)              */
/* ------------------------------------------------------------------ */

describe("market sharded submit through the seam (#4280)", () => {
  function shardedService() {
    const mockSql = { exec: vi.fn(() => []) };
    const mockEnv = {
      ETRADE_ENVIRONMENT: "sandbox",
      ETRADE_SANDBOX_BASE_URL: "https://apisb.etrade.com",
      ETRADE_SANDBOX_CONSUMER_KEY: "mock_consumer_key",
      ETRADE_SANDBOX_CONSUMER_SECRET: "mock_consumer_secret",
    } as unknown as Env;
    const mockOrm = new DatabaseORM(mockSql as any);
    const service = new ScheduledTasksService(mockEnv, mockOrm, "test_trader");
    const publish = vi.fn(async () => {});
    (service as any).publishScreenerEvent = publish;
    (service as any).guardScheduledAuth = async () => ({ blocked: false });
    (service as any).getScreenerAgent = () => ({
      isScreenRunning: async () => ({ running: false, startedAt: null }),
    });
    const submit = vi.fn(async (input: never) => {
      const overrides = (input as unknown as { commandOverrides?: { jobId?: string } })
        .commandOverrides;
      const jobId = overrides?.jobId ?? "chain-missing";
      return { jobId, workflowId: `wf-${jobId}` };
    });
    (service as any).submitStockScreenViaEngine = submit;
    return { service, publish, submit };
  }

  it("submits via the seam with jobId == chainId, delivery envelope, and stageChain", async () => {
    const { service, submit } = shardedService();
    const result = await service.autonomousMarketScreen({
      sharded: true,
      stageChain: { serveDelaySeconds: 60, deliverDelaySeconds: 3600 },
      emailTo: "ops@example.com",
      slackChannel: "#screener",
      webhookUrl: "https://example.test/hook",
    });
    expect(submit).toHaveBeenCalledTimes(1);
    const input = submit.mock.calls[0][0] as {
      spec: Record<string, unknown>;
      commandOverrides: Record<string, unknown>;
    };
    expect(result.success).toBe(true);
    expect((result as unknown as { data: Record<string, unknown> }).data.sharded).toBe(true);
    const chainId = (result as unknown as { data: Record<string, unknown> }).data.chainId as string;
    expect(typeof chainId).toBe("string");
    expect(chainId.length).toBeGreaterThan(0);
    expect(input.commandOverrides.jobId).toBe(chainId);
    expect(input.spec.deliver).toBe(true);
    expect(input.spec.trigger).toBe("scheduled");
    expect(input.spec.universe).toBe("TECH");
    expect(input.spec.delivery).toEqual({
      emailTo: "ops@example.com",
      slackChannel: "#screener",
      webhookUrl: "https://example.test/hook",
      pushToSlack: true,
    });
    expect(input.spec.stageChain).toEqual({ serveDelaySeconds: 60, deliverDelaySeconds: 3600 });
  });

  it("a seam rejection runs the #1851 failure path (audit + screener.failed, no silent return)", async () => {
    const { service, publish, submit } = shardedService();
    submit.mockRejectedValueOnce(new Error("submit boom"));
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(result.success).toBe(false);
    const failed = publish.mock.calls.map((c) => c[0]).filter((e: never) => (e as { type: string }).type === "screener.failed");
    expect(failed).toHaveLength(1);
    expect((failed[0] as { error: string }).error).toContain("submit boom");
  });

  it("a held lock refuses before the seam (already-running, fail-closed)", async () => {
    const { service, submit } = shardedService();
    (service as unknown as Record<string, unknown>).getScreenerAgent = () => ({
      isScreenRunning: async () => ({ running: true, startedAt: Date.now() }),
    });
    const result = await service.autonomousMarketScreen({ sharded: true });
    expect(submit).not.toHaveBeenCalled();
    expect((result as unknown as Record<string, unknown>).skipped).toBe(true);
    expect((result as unknown as Record<string, unknown>).skippedReason).toBe("already-running");
  });
});

/* ------------------------------------------------------------------ */
/* No live chain calls                                                 */
/* ------------------------------------------------------------------ */

describe("no live chain calls (#4280)", () => {
  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, out);
      else if (entry.name.endsWith(".ts")) out.push(path);
    }
    return out;
  }

  it("startScheduledShardedChain lives only in its deprecated module (plus tests)", () => {
    const offenders: string[] = [];
    for (const path of walk("src")) {
      const text = readFileSync(path, "utf8");
      if (!text.includes("startScheduledShardedChain")) continue;
      const rel = path.split(/[\\/]/).join("/");
      if (rel === "src/workflows/startScheduledShardedChain.deprecated.ts") continue;
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  it("scheduledTasks and the broker contain no chain-start reference", () => {
    expect(read("services/scheduledTasks.ts")).not.toContain("startScheduledShardedChain");
    expect(read("services/scheduledTasks.ts")).not.toContain("planFeedStart");
    expect(read("workflows/screenExecutionBroker.ts")).not.toContain("startScheduledShardedChain");
  });

  it("planFeedStart is called only from the deprecated module (and its own file)", () => {
    // Live uses only: the G7 note and aspect docs name planFeedStart in
    // prose, which is history, not a call. A call is `planFeedStart(` or
    // a destructured import `{ planFeedStart }`.
    const offenders: string[] = [];
    for (const path of walk("src")) {
      const text = readFileSync(path, "utf8");
      if (!/planFeedStart\s*\(/.test(text) && !/\{\s*planFeedStart\s*\}/.test(text)) continue;
      const rel = path.split(/[\\/]/).join("/");
      if (
        rel === "src/services/shardJobs.ts" ||
        rel === "src/workflows/startScheduledShardedChain.deprecated.ts"
      ) {
        continue;
      }
      offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });
});
