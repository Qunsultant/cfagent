// @vitest-environment node
/**
 * Issue #3943 — delivery suppression re-homed onto the J
 * deliver stage: the J stage consults the ONE suppressor
 * module (src/workflows/screenDeliverySuppression.ts) with
 * an injected store, claiming (runId, destination) pairs in
 * the screener's key space, so a re-run/replay of a
 * delivered report never re-sends to the same destination.
 * The contract under test:
 *  - key reconciliation: every send claims the screener's
 *    key for the pair — deliverySuppressionKey(runId,
 *    deliveryDestinationFor(channel, recipient)) — so a
 *    screener's claim and a J stage's claim name the same
 *    pair; the ux channel is a read-back, never a send, and
 *    never claims;
 *  - re-run/replay: a second run with the same run id and
 *    the same claims store does not call the sender again —
 *    the pair records already_delivered, even when the
 *    delivery dataset store cannot see the first run;
 *  - a failed send (or an unconfiguredReason outcome)
 *    releases its claim, so the pair retries on the next
 *    run; a not-configured pair never claims;
 *  - wiring: the host injects a suppressor backed by the
 *    durable mas_delivery_claims table; the deliver step
 *    forwards its injected suppressor to the run.
 */
import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import type { GeneratedDatasetStoreInput } from "../src/data/generatedDatasetPorts";
import {
  buildDeliverJobRegistry,
  runDeliverJob,
} from "../src/services/deliverJobs";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
  deliverySuppressionKey,
  type DeliverySuppressionStore,
  type DeliverySuppressor,
} from "../src/workflows/screenDeliverySuppression";
import {
  DELIVER_APPLY_STEP,
  registerDeliverStep,
} from "../src/services/deliverPipelineJobs";
import {
  JobStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import {
  deliverStepDepsForScheduledAgent,
  type ScheduledTasksPipelineContext,
} from "../src/agents/scheduledTasksPipeline";
import type { SqlStorage } from "../src/orm";
import type { Env } from "../src/types";

const GENERATE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze-generate";
const JOB = `${GENERATE_JOB}-deliver`;
const T0 = Date.parse("2026-11-07T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const PDF_B64 = Buffer.from("PDFBYTES").toString("base64");

/** A recording DeliverySuppressionStore: the claim keys are the assertion. */
class RecordingSuppressionStore implements DeliverySuppressionStore {
  readonly claimed = new Map<string, true>();
  has(key: string): boolean {
    return this.claimed.has(key);
  }
  add(key: string): void {
    this.claimed.set(key, true);
  }
  delete(key: string): void {
    this.claimed.delete(key);
  }
  keys(): string[] {
    return [...this.claimed.keys()].sort();
  }
}

/** The node:sqlite DO-storage double (tests/deliver_pipeline_host_3539.test.ts idiom). */
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

function makeHostContext(env: Partial<Env> = {}) {
  const sql = new SqliteTestStorage();
  const kv = new Map<string, unknown>();
  const agentCtx = {
    storage: {
      sql,
      get: async (key: string) => kv.get(key),
      put: async (key: string, value: unknown) => {
        kv.set(key, value);
      },
    },
  };
  const ctx = {
    env: env as Env,
    agentCtx: agentCtx as unknown as ScheduledTasksPipelineContext["agentCtx"],
  } satisfies ScheduledTasksPipelineContext;
  return { ctx, sql };
}
function generatedInput(
  runId: string,
  atMs: number,
  overrides: Partial<GeneratedDatasetStoreInput> = {},
): GeneratedDatasetStoreInput {
  return {
    jobId: GENERATE_JOB,
    analyzeJobId: "yahoo-nasdaq100-quotes-enrich-analyze",
    enrichJobId: "yahoo-nasdaq100-quotes-enrich",
    feedJobId: "yahoo-nasdaq100-quotes",
    sourceId: "yahoo",
    dataset: "quotes",
    universe: {
      kind: "index",
      index: "nasdaq100",
      label: "Nasdaq-100",
      snapshotDate: "2026-11-02",
      sourceLabel: "Wikipedia (Nasdaq-100 table)",
      size: 2,
    },
    inputArtifactId: `analyzed-${runId}`,
    inputRunId: `analyze-${runId}`,
    inputAsOf: iso(atMs - 3600_000),
    reportsRequested: ["analysis"],
    formatsRequested: ["json", "markdown", "pdf"],
    reports: [
      {
        kind: "analysis",
        title: "Analysis — yahoo quotes",
        formats: [
          {
            format: "json",
            status: "generated",
            contentType: "application/json",
            bodyText: "{\"ok\":true}",
            bodyBase64: null,
            sizeBytes: 10,
            codedError: null,
            errorMessage: null,
          },
          {
            format: "markdown",
            status: "generated",
            contentType: "text/markdown",
            bodyText: "# Analysis\nbody",
            bodyBase64: null,
            sizeBytes: 15,
            codedError: null,
            errorMessage: null,
          },
          {
            format: "pdf",
            status: "generated",
            contentType: "application/pdf",
            bodyText: null,
            bodyBase64: PDF_B64,
            sizeBytes: 8,
            codedError: null,
            errorMessage: null,
          },
        ],
        canonical: {
          status: "not_wired",
          reportId: null,
          fanoutCode: null,
          reason: "canonical_report_store_not_wired",
        },
      },
    ],
    summary: {
      reportsGenerated: 1,
      formatsGenerated: 3,
      formatsFailed: 0,
      canonicalStored: 0,
      canonicalNotWired: 1,
    },
    run: {
      runId,
      trigger: "manual",
      startedAt: iso(atMs),
      finishedAt: iso(atMs + 1000),
      status: "completed",
      requested: 3,
      received: 3,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
    ...overrides,
  };
}
interface SpySenders {
  senders: DeliverChannelSenders;
  calls: { slack: any[]; email: any[]; webhook: any[] };
}

function spySenders(
  behavior: {
    slack?: (input: any) => Promise<{ ok: boolean; error?: string; target?: string }>;
    email?: (input: any) => Promise<{ ok: boolean; error?: string; target?: string }>;
    webhook?: (input: any) => Promise<{ ok: boolean; error?: string; target?: string }>;
  } = {},
): SpySenders {
  const calls: SpySenders["calls"] = { slack: [], email: [], webhook: [] };
  return {
    calls,
    senders: {
      slack: async (input: any) => {
        calls.slack.push(input);
        return behavior.slack ? behavior.slack(input) : { ok: true };
      },
      email: async (input: any) => {
        calls.email.push(input);
        return behavior.email ? behavior.email(input) : { ok: true };
      },
      webhook: async (input: any) => {
        calls.webhook.push(input);
        return behavior.webhook
          ? behavior.webhook(input)
          : { ok: true, target: "hooks.example.com" };
      },
    },
  };
}

const EMAIL_ENV = {
  DELIVER_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_DELIVER_EMAIL_TO:
    "ops@example.com",
  DELIVER_JOB_YAHOO_NASDAQ100_QUOTES_ENRICH_ANALYZE_GENERATE_DELIVER_SLACK_CHANNEL:
    "#reports",
};

async function seededWorld(env: Record<string, string | undefined> = EMAIL_ENV) {
  const generatedStore = new InMemoryGeneratedDatasetStore();
  await generatedStore.store(generatedInput("gen-1", T0));
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const registry = buildDeliverJobRegistry(env);
  return { generatedStore, deliveryStore, registry };
}

describe("deliver suppression, re-homed (#3943)", () => {
  it("claims (runId, destination) pairs in the screener's key space as it sends", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders, suppressor },
      JOB,
      {
        runId: "deliver-1",
        nowMs: T0 + 60_000,
        channels: ["slack", "email", "webhook", "ux"],
      },
    );
    expect(result.status).toBe("completed");
    expect(store.keys()).toEqual(
      [
        deliverySuppressionKey("deliver-1", deliveryDestinationFor("slack")),
        deliverySuppressionKey(
          "deliver-1",
          deliveryDestinationFor("email", "ops@example.com"),
        ),
        deliverySuppressionKey("deliver-1", deliveryDestinationFor("webhook")),
      ].sort(),
    );
    // The ux channel is a read-back, not a send — it never claims.
    expect(store.keys().some((k) => k.includes("ux"))).toBe(false);
  });

  it("a re-run with the same run id and the same claims store does not re-send", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const first = spySenders();
    await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: first.senders, suppressor },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack", "email", "webhook"] },
    );
    expect(first.calls.slack).toHaveLength(1);
    expect(first.calls.email).toHaveLength(1);
    expect(first.calls.webhook).toHaveLength(1);

    // Fresh delivery store: the per-input resume guard cannot
    // see the first run — only the suppressor can stop the
    // re-send.
    const freshDeliveryStore = new InMemoryDeliveryDatasetStore();
    const second = spySenders();
    const r2 = await runDeliverJob(
      registry,
      {
        generatedStore,
        deliveryStore: freshDeliveryStore,
        senders: second.senders,
        suppressor,
      },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 120_000, channels: ["slack", "email", "webhook"] },
    );
    expect(second.calls.slack).toHaveLength(0);
    expect(second.calls.email).toHaveLength(0);
    expect(second.calls.webhook).toHaveLength(0);
    expect(r2.status).toBe("completed");
    expect(r2.channelOutcomes.map((o) => `${o.channel}:${o.status}`)).toEqual([
      "slack:already_delivered",
      "email:already_delivered",
      "webhook:already_delivered",
    ]);
    // The detail on the recorded pairs names the suppressor claim.
    const artifact = await freshDeliveryStore.latest(JOB);
    expect(
      artifact?.reports[0]?.channels.every(
        (c) =>
          c.status === "already_delivered" &&
          c.detail?.includes("deliver-1::"),
      ),
    ).toBe(true);
  });

  it("a screener's claim suppresses the J stage — same module, same key", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const store = new RecordingSuppressionStore();
    // The screener executor's claim for a workflow run, made
    // through the one suppressor module with the screener's
    // delivery id.
    createDeliverySuppressor(store).tryClaim(
      "workflow:job-1",
      deliveryDestinationFor("slack"),
    );
    const suppressor = createDeliverySuppressor(store);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders, suppressor },
      JOB,
      { runId: "workflow:job-1", nowMs: T0 + 60_000, channels: ["slack", "email"] },
    );
    expect(spy.calls.slack).toHaveLength(0);
    expect(spy.calls.email).toHaveLength(1);
    expect(result.channelOutcomes.map((o) => `${o.channel}:${o.status}`)).toEqual([
      "slack:already_delivered",
      "email:delivered",
    ]);
  });

  it("a failed send releases its claim — the pair retries on the next run", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const failing = spySenders({
      webhook: async () => ({ ok: false, error: "hook down" }),
    });
    const r1 = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: failing.senders, suppressor },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack", "webhook"] },
    );
    expect(r1.status).toBe("partial");
    expect(failing.calls.webhook).toHaveLength(1);
    expect(suppressor.wasClaimed("deliver-1", deliveryDestinationFor("webhook"))).toBe(
      false,
    );
    expect(suppressor.wasClaimed("deliver-1", deliveryDestinationFor("slack"))).toBe(true);

    const retry = spySenders();
    const r2 = await runDeliverJob(
      registry,
      {
        generatedStore,
        deliveryStore: new InMemoryDeliveryDatasetStore(),
        senders: retry.senders,
        suppressor,
      },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 120_000, channels: ["slack", "webhook"] },
    );
    expect(retry.calls.webhook).toHaveLength(1);
    expect(retry.calls.slack).toHaveLength(0);
    expect(r2.channelOutcomes.map((o) => `${o.channel}:${o.status}`)).toEqual([
      "slack:already_delivered",
      "webhook:delivered",
    ]);
  });

  it("a not-configured pair never claims — the claim follows the send, not the attempt", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld({});
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders, suppressor },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["email"] },
    );
    expect(result.channelOutcomes).toEqual([
      { reportKind: "analysis", channel: "email", status: "not_configured" },
    ]);
    expect(store.keys()).toEqual([]);
  });

  it("an unconfiguredReason outcome releases its claim", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const unconfiguredCalls: unknown[] = [];
    const r1 = await runDeliverJob(
      registry,
      {
        generatedStore,
        deliveryStore,
        senders: {
          webhook: async (input: unknown) => {
            unconfiguredCalls.push(input);
            return { ok: false, unconfiguredReason: "webhook_secret_missing" };
          },
        },
        suppressor,
      },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["webhook"] },
    );
    expect(unconfiguredCalls).toHaveLength(1);
    expect(r1.channelOutcomes.map((o) => o.status)).toEqual(["not_configured"]);
    expect(suppressor.wasClaimed("deliver-1", deliveryDestinationFor("webhook"))).toBe(
      false,
    );

    const retry = spySenders();
    const r2 = await runDeliverJob(
      registry,
      {
        generatedStore,
        deliveryStore: new InMemoryDeliveryDatasetStore(),
        senders: retry.senders,
        suppressor,
      },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 120_000, channels: ["webhook"] },
    );
    expect(retry.calls.webhook).toHaveLength(1);
    expect(r2.channelOutcomes.map((o) => o.status)).toEqual(["delivered"]);
  });

  it("the host injects a suppressor backed by the durable claims table", async () => {
    const { ctx, sql } = makeHostContext();
    const deps = deliverStepDepsForScheduledAgent(ctx);
    expect(deps.suppressor).toBeDefined();
    const suppressor = deps.suppressor as DeliverySuppressor;
    expect(suppressor.tryClaim("run-1", "slack")).toBe(true);
    // A second deps object built from the same host sees the
    // claim — the store is the host's durable table, not a
    // fresh in-memory set.
    const again = deliverStepDepsForScheduledAgent(ctx);
    expect((again.suppressor as DeliverySuppressor).wasClaimed("run-1", "slack")).toBe(
      true,
    );
    const rows = sql.exec("SELECT key FROM mas_delivery_claims") as {
      key: string;
    }[];
    expect(rows.map((r) => r.key)).toContain("run-1::slack");
  });

  it("the deliver step forwards its injected suppressor to the run", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const store = new RecordingSuppressionStore();
    const suppressor = createDeliverySuppressor(store);
    const stepRegistry = new JobStepRegistry();
    registerDeliverStep(stepRegistry, {
      registry,
      generatedStore,
      deliveryStore,
      senders: spySenders().senders,
      suppressor,
    });
    const handler = stepRegistry.resolve(DELIVER_APPLY_STEP);
    const ctx: JobStepContext = {
      jobId: JOB,
      runId: "step-run-1",
      nodePath: "",
      kind: "deliver",
      stepIndex: 0,
      item: null,
      itemIndex: null,
      items: [],
      shardKey: null,
      params: { deliverJobId: JOB, channels: ["slack"] },
      input: null,
      now: iso(T0),
    };
    await handler(ctx);
    expect(store.keys()).toEqual([
      deliverySuppressionKey("step-run-1", deliveryDestinationFor("slack")),
    ]);
  });
});
