// @vitest-environment node
/**
 * Issue #4438 — the durable delivery-suppression claims door
 * (audit item E-3 from #3943's §15): the workflow residency's
 * deliver stage consults the DURABLE claims store through the
 * orchestrator door — one mas_delivery_claims table shared by
 * every residency — instead of its bare in-memory suppressor,
 * so a delivery suppressed once stays suppressed across a
 * restart/retry of the run. The claim is visible in the run
 * record: the deliver run result and the step output carry
 * the suppressed claim keys, and the step descriptor names
 * the suppression.
 *
 * The contract under test:
 *  - the ONE suppressor module gains an async seam (same key
 *    discipline, async backing) — the sync seam is untouched;
 *  - the door handler (orchestrator side) claims into the
 *    sync suppressor over mas_delivery_claims; the
 *    door-backed suppressor (caller side) resolves the door
 *    lazily and delegates with the canonical keys;
 *  - a restart (a fresh suppressor instance over the same
 *    door) does not re-send: the second claim is held;
 *  - runDeliverJob awaits the async seam: a pre-claimed pair
 *    suppresses without calling the sender, a failed send
 *    releases through the door, and the result names the
 *    suppressed claim keys;
 *  - the deliver step forwards the async suppressor, and its
 *    output + descriptor carry the suppression visibly;
 *  - the workflow residency wires the door-backed suppressor
 *    (no in-memory fallback in production wiring).
 */
import { describe, expect, it } from "vitest";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import type { GeneratedDatasetStoreInput } from "../src/data/generatedDatasetPorts";
import {
  buildDeliverJobRegistry,
  runDeliverJob,
} from "../src/services/deliverJobs";
import {
  createAsyncDeliverySuppressor,
  createDeliverySuppressor,
  deliveryDestinationFor,
  deliverySuppressionKey,
  type AsyncDeliverySuppressionStore,
} from "../src/workflows/screenDeliverySuppression";
import {
  createDeliveryClaimsDoor,
  createDoorDeliverySuppressor,
  type DeliveryClaimsDoor,
} from "../src/services/deliveryClaimsDoor";
import {
  DELIVER_APPLY_STEP,
  registerDeliverStep,
} from "../src/services/deliverPipelineJobs";
import {
  JobStepRegistry,
  type JobStepContext,
} from "../src/services/jobPipelineSteps";
import { createWorkflowDeliveryClaimsSuppressor } from "../src/workflows/jobPipelineWorkflow";
import type { Env } from "../src/types";

const GENERATE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze-generate";
const JOB = `${GENERATE_JOB}-deliver`;
const T0 = Date.parse("2026-11-07T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

/** An async in-memory claims store: the async seam's recording double. */
class RecordingAsyncStore implements AsyncDeliverySuppressionStore {
  readonly claimed = new Map<string, true>();
  async has(key: string): Promise<boolean> {
    return this.claimed.has(key);
  }
  async add(key: string): Promise<void> {
    this.claimed.set(key, true);
  }
  async delete(key: string): Promise<void> {
    this.claimed.delete(key);
  }
  keys(): string[] {
    return [...this.claimed.keys()].sort();
  }
}

/** A fake orchestrator door over one shared set: the durable table double. */
class FakeClaimsDoor implements DeliveryClaimsDoor {
  readonly claimed = new Set<string>();
  readonly calls: Array<{ op: string; runId: string; destination: string }> = [];
  async tryClaimDelivery(input: { runId: string; destination: string }) {
    const key = deliverySuppressionKey(input.runId, input.destination);
    this.calls.push({ op: "tryClaim", ...input });
    if (this.claimed.has(key)) return { claimed: false, key };
    this.claimed.add(key);
    return { claimed: true, key };
  }
  async wasClaimedDelivery(input: { runId: string; destination: string }) {
    const key = deliverySuppressionKey(input.runId, input.destination);
    this.calls.push({ op: "wasClaimed", ...input });
    return { claimed: this.claimed.has(key), key };
  }
  async releaseDeliveryClaim(input: { runId: string; destination: string }) {
    const key = deliverySuppressionKey(input.runId, input.destination);
    this.calls.push({ op: "release", ...input });
    this.claimed.delete(key);
  }
}

function generatedInput(
  runId: string,
  atMs: number,
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
    formatsRequested: ["json", "markdown"],
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
      formatsGenerated: 2,
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
      requested: 2,
      received: 2,
      failed: 0,
      codedError: null,
      errorMessage: null,
    },
    nowIso: iso(atMs),
  };
}

function spySenders() {
  const calls: { slack: unknown[]; email: unknown[]; webhook: unknown[] } = {
    slack: [],
    email: [],
    webhook: [],
  };
  return {
    calls,
    senders: {
      slack: async (input: unknown) => {
        calls.slack.push(input);
        return { ok: true };
      },
      email: async (input: unknown) => {
        calls.email.push(input);
        return { ok: true };
      },
      webhook: async (input: unknown) => {
        calls.webhook.push(input);
        return { ok: true, target: "hooks.example.com" };
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

async function seededWorld() {
  const generatedStore = new InMemoryGeneratedDatasetStore();
  await generatedStore.store(generatedInput("gen-1", T0));
  const deliveryStore = new InMemoryDeliveryDatasetStore();
  const registry = buildDeliverJobRegistry(EMAIL_ENV);
  return { generatedStore, deliveryStore, registry };
}

describe("async suppressor seam (#4438)", () => {
  it("claims once, holds the second claim, releases on demand — the sync discipline, async backing", async () => {
    const store = new RecordingAsyncStore();
    const suppressor = createAsyncDeliverySuppressor(store);
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(false);
    expect(await suppressor.wasClaimed("run-1", "slack")).toBe(true);
    expect(await suppressor.wasClaimed("run-1", "email")).toBe(false);
    await suppressor.release("run-1", "slack");
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(store.keys()).toEqual(["run-1::slack"]);
  });

  it("keys canonically: destinations are trimmed, like the sync seam", async () => {
    const store = new RecordingAsyncStore();
    const suppressor = createAsyncDeliverySuppressor(store);
    expect(await suppressor.tryClaim("  run-1 ", "  slack ")).toBe(true);
    expect(await suppressor.wasClaimed("run-1", "slack")).toBe(true);
    expect(store.keys()).toEqual(["run-1::slack"]);
  });
});

describe("claims door handler, orchestrator side (#4438)", () => {
  it("claims into the sync suppressor and names the canonical key", async () => {
    const sync = createDeliverySuppressor();
    const door = createDeliveryClaimsDoor(sync);
    const first = await door.tryClaimDelivery({ runId: "run-1", destination: "slack" });
    expect(first).toEqual({ claimed: true, key: "run-1::slack" });
    const second = await door.tryClaimDelivery({ runId: "run-1", destination: "slack" });
    expect(second).toEqual({ claimed: false, key: "run-1::slack" });
    expect(
      await door.wasClaimedDelivery({ runId: "run-1", destination: "slack" }),
    ).toEqual({ claimed: true, key: "run-1::slack" });
    await door.releaseDeliveryClaim({ runId: "run-1", destination: "slack" });
    expect(
      await door.wasClaimedDelivery({ runId: "run-1", destination: "slack" }),
    ).toEqual({ claimed: false, key: "run-1::slack" });
  });

  it("two handlers over one store share claims — the door is one table, not one instance", async () => {
    const sync = createDeliverySuppressor();
    const first = createDeliveryClaimsDoor(sync);
    const second = createDeliveryClaimsDoor(sync);
    expect(
      (await first.tryClaimDelivery({ runId: "run-1", destination: "slack" })).claimed,
    ).toBe(true);
    expect(
      (await second.tryClaimDelivery({ runId: "run-1", destination: "slack" })).claimed,
    ).toBe(false);
  });
});

describe("door-backed suppressor, caller side (#4438)", () => {
  it("delegates with the canonical keys and resolves the door lazily, once", async () => {
    const door = new FakeClaimsDoor();
    let resolutions = 0;
    const suppressor = createDoorDeliverySuppressor(() => {
      resolutions += 1;
      return door;
    });
    expect(resolutions).toBe(0);
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(false);
    expect(resolutions).toBe(1);
    expect(door.calls).toEqual([
      { op: "tryClaim", runId: "run-1", destination: "slack" },
      { op: "tryClaim", runId: "run-1", destination: "slack" },
    ]);
    expect(await suppressor.wasClaimed("run-1", "slack")).toBe(true);
    await suppressor.release("run-1", "slack");
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(resolutions).toBe(1);
  });

  it("a restart — a fresh suppressor over the same door — does not re-send", async () => {
    const door = new FakeClaimsDoor();
    const before = createDoorDeliverySuppressor(() => door);
    expect(await before.tryClaim("run-1", "slack")).toBe(true);
    // The restart: a new suppressor instance, same door (same table).
    const after = createDoorDeliverySuppressor(() => door);
    expect(await after.tryClaim("run-1", "slack")).toBe(false);
    expect(await after.wasClaimed("run-1", "slack")).toBe(true);
  });
});

describe("deliver run over the door (#4438)", () => {
  it("a pre-claimed pair suppresses without sending, and the result names the claim key", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const door = new FakeClaimsDoor();
    await door.tryClaimDelivery({
      runId: "deliver-1",
      destination: deliveryDestinationFor("slack"),
    });
    const suppressor = createDoorDeliverySuppressor(() => door);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders, suppressor },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack", "email"] },
    );
    expect(spy.calls.slack).toHaveLength(0);
    expect(spy.calls.email).toHaveLength(1);
    expect(result.channelOutcomes.map((o) => `${o.channel}:${o.status}`)).toEqual([
      "slack:already_delivered",
      "email:delivered",
    ]);
    expect(result.suppressedClaims).toEqual([
      deliverySuppressionKey("deliver-1", deliveryDestinationFor("slack")),
    ]);
  });

  it("a fresh run sends and reports no suppressed claims", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const door = new FakeClaimsDoor();
    const suppressor = createDoorDeliverySuppressor(() => door);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders, suppressor },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack", "email"] },
    );
    expect(spy.calls.slack).toHaveLength(1);
    expect(spy.calls.email).toHaveLength(1);
    expect(result.suppressedClaims).toEqual([]);
  });

  it("a failed send releases through the door — the pair retries on the next run", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const door = new FakeClaimsDoor();
    const suppressor = createDoorDeliverySuppressor(() => door);
    const failing = {
      calls: { webhook: [] as unknown[] },
      senders: {
        webhook: async (input: unknown) => {
          failing.calls.webhook.push(input);
          return { ok: false, error: "hook down" };
        },
      },
    };
    const r1 = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: failing.senders, suppressor },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["webhook"] },
    );
    expect(r1.status).toBe("failed"); // every attempted channel failed: the one pair
    expect(
      (await door.wasClaimedDelivery({
        runId: "deliver-1",
        destination: deliveryDestinationFor("webhook"),
      })).claimed,
    ).toBe(false);
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
    expect(r2.suppressedClaims).toEqual([]);
  });

  it("the deliver step forwards the async suppressor and surfaces the suppression in its output and descriptor", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const door = new FakeClaimsDoor();
    await door.tryClaimDelivery({
      runId: "step-run-1",
      destination: deliveryDestinationFor("slack"),
    });
    const suppressor = createDoorDeliverySuppressor(() => door);
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
    const result = await handler(ctx);
    const output = result.output as { suppressedClaims: string[] };
    expect(output.suppressedClaims).toEqual([
      deliverySuppressionKey("step-run-1", deliveryDestinationFor("slack")),
    ]);
    expect(result.descriptor).toContain("suppressed by delivery claim");
    expect(result.descriptor).toContain("step-run-1::slack");
  });
});

describe("workflow residency wiring (#4438)", () => {
  it("the workflow residency's suppressor claims through the orchestrator door, resolved lazily", async () => {
    const door = new FakeClaimsDoor();
    let gets = 0;
    const namespace = {
      idFromName: (name: string) => `id:${name}`,
      get: () => {
        gets += 1;
        return door;
      },
    };
    const env = { ORCHESTRATOR_AGENT: namespace } as unknown as Env;
    const suppressor = createWorkflowDeliveryClaimsSuppressor(env);
    expect(gets).toBe(0);
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(true);
    expect(await suppressor.tryClaim("run-1", "slack")).toBe(false);
    expect(gets).toBe(1);
    expect(door.calls.map((c) => c.op)).toEqual(["tryClaim", "tryClaim"]);
  });

  it("an unbound orchestrator namespace fails the first claim closed with a named error, never a silent send", async () => {
    const env = {} as unknown as Env;
    const suppressor = createWorkflowDeliveryClaimsSuppressor(env);
    await expect(suppressor.tryClaim("run-1", "slack")).rejects.toThrow(
      /ActorGateway: DO namespace binding is not configured/,
    );
  });
});
