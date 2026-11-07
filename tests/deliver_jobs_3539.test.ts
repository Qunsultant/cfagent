// @vitest-environment node
/**
 * Issue #3539 (Pipeline J6) — the deliver service: a run
 * consumes the generate job's PERSISTED generated dataset
 * (never a fetch, never a re-render), delivers each persisted
 * report over the configured channels, and records every
 * delivery with its outcome per channel. The contract under
 * test:
 *  - per-channel independence: one channel's failure never
 *    blocks, taints, or duplicates another's delivery;
 *  - honesty: a channel that cannot be attempted is recorded
 *    not_configured with a coded reason (never a fake
 *    delivered state), and not_configured pairs are excluded
 *    from the run's requested tally;
 *  - resume: an earlier run over the SAME generated copy
 *    marks its delivered pairs already_delivered — the sender
 *    is not called again (a completed channel is never
 *    delivered twice for the same generated copy) — while a
 *    failed pair retries;
 *  - missing persisted input refuses BY NAME
 *    (DELIVER_INPUT_MISSING) with the failed run recorded
 *    first; all-attempted-channels-failed is
 *    DELIVER_ALL_CHANNELS_FAILED;
 *  - the ux channel is a verified read-back through the
 *    generated store port, and its detail names which UX
 *    surfaces hold the report (the Reports view only when the
 *    input's canonical leg was stored/deduped);
 *  - the production sender factory composes the platform's
 *    existing transports (Slack via the unified screener
 *    sender's env shape, email via cfpay / the EmailSender
 *    port, webhook via the signed outbound dispatch) and
 *    names unconfigured transports instead of inventing one.
 */
import { describe, expect, it } from "vitest";
import { InMemoryGeneratedDatasetStore } from "../src/data/inMemoryGeneratedDatasetAdapter";
import { InMemoryDeliveryDatasetStore } from "../src/data/inMemoryDeliveryDatasetAdapter";
import type { GeneratedDatasetStoreInput } from "../src/data/generatedDatasetPorts";
import {
  buildDeliverJobRegistry,
  buildDeliverStatus,
  createDeliverChannelSenders,
  DeliverJobError,
  DELIVER_GAP_CODES,
  DELIVER_JOB_CODES,
  runDeliverJob,
  validateDeliverChannels,
  type DeliverChannelSenders,
} from "../src/services/deliverJobs";

const GENERATE_JOB = "yahoo-nasdaq100-quotes-enrich-analyze-generate";
const JOB = `${GENERATE_JOB}-deliver`;
const T0 = Date.parse("2026-11-07T13:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();
const PDF_B64 = Buffer.from("PDFBYTES").toString("base64");

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

describe("deliver service (#3539)", () => {
  it("delivers every channel and records each outcome", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(4);
    expect(result.received).toBe(4);
    expect(result.failed).toBe(0);
    expect(result.reportsDelivered).toEqual(["analysis"]);
    expect(
      result.channelOutcomes.map((o) => `${o.channel}:${o.status}`),
    ).toEqual([
      "slack:delivered",
      "email:delivered",
      "webhook:delivered",
      "ux:delivered",
    ]);
    // The channel payloads come from the PERSISTED copy: the
    // markdown body is the text carried, the pdf rides along.
    expect(spy.calls.slack[0].text).toBe("# Analysis\nbody");
    expect(spy.calls.slack[0].channel).toBe("#reports");
    expect(spy.calls.slack[0].pdf.fileName).toBe("analysis.pdf");
    expect(Array.from(spy.calls.slack[0].pdf.bytes as Uint8Array)).toEqual(
      Array.from(Buffer.from("PDFBYTES")),
    );
    expect(spy.calls.email[0].to).toBe("ops@example.com");
    expect(spy.calls.email[0].attachment.contentBase64).toBe(PDF_B64);
    expect(spy.calls.webhook[0].event).toBe("pipeline.report");
    expect(spy.calls.webhook[0].data.generatedRunId).toBe("gen-1");
    const artifact = await deliveryStore.latest(JOB);
    expect(artifact?.run.runId).toBe("deliver-1");
    expect(artifact?.summary.channelsDelivered).toBe(4);
    expect(artifact?.inputRunId).toBe("gen-1");
    // The ux record names the panel; the Reports view is named
    // only as NOT holding the copy (canonical leg not_wired).
    const ux = artifact?.reports[0]?.channels.find((c) => c.channel === "ux");
    expect(ux?.status).toBe("delivered");
    expect(ux?.detail).toContain("Data Providers panel (generated copy)");
    expect(ux?.detail).toContain("canonical copy not stored");
  });

  it("names the Reports view when the canonical leg was stored", async () => {
    const generatedStore = new InMemoryGeneratedDatasetStore();
    const seeded = generatedInput("gen-1", T0);
    seeded.reports[0]!.canonical = {
      status: "stored",
      reportId: "rpt-1",
      fanoutCode: null,
      reason: null,
    };
    await generatedStore.store(seeded);
    const deliveryStore = new InMemoryDeliveryDatasetStore();
    const registry = buildDeliverJobRegistry(EMAIL_ENV);
    const spy = spySenders();
    await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000 },
    );
    const ux = (await deliveryStore.latest(JOB))?.reports[0]?.channels.find(
      (c) => c.channel === "ux",
    );
    expect(ux?.detail).toContain("Reports view (canonical copy)");
  });

  it("one channel's failure never blocks the others (partial)", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const spy = spySenders({
      slack: async () => ({ ok: false, error: "slack is down" }),
    });
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("partial");
    expect(result.requested).toBe(4);
    expect(result.received).toBe(3);
    expect(result.failed).toBe(1);
    expect(result.codedError).toBeNull();
    const artifact = await deliveryStore.latest(JOB);
    const slack = artifact?.reports[0]?.channels.find((c) => c.channel === "slack");
    expect(slack?.status).toBe("failed");
    expect(slack?.codedError).toBe(DELIVER_GAP_CODES.channelSendFailed);
    expect(slack?.errorMessage).toContain("slack is down");
    expect(spy.calls.email).toHaveLength(1);
    expect(spy.calls.webhook).toHaveLength(1);
  });

  it("all attempted channels failing is DELIVER_ALL_CHANNELS_FAILED", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const spy = spySenders({
      slack: async () => ({ ok: false, error: "no" }),
      webhook: async () => ({ ok: false, error: "no" }),
    });
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack", "webhook"] },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(DELIVER_JOB_CODES.allChannelsFailed);
    expect((await deliveryStore.latest(JOB))?.run.codedError).toBe(
      DELIVER_JOB_CODES.allChannelsFailed,
    );
  });

  it("unconfigured channels record not_configured and stay out of the tally", async () => {
    const generatedStore = new InMemoryGeneratedDatasetStore();
    await generatedStore.store(generatedInput("gen-1", T0));
    const deliveryStore = new InMemoryDeliveryDatasetStore();
    // No EMAIL_TO / SLACK_CHANNEL knobs, and NO senders at all:
    // every external channel is a configuration absence.
    const registry = buildDeliverJobRegistry({});
    const { senders, unconfiguredReasons } = createDeliverChannelSenders({});
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders, unconfiguredReasons },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000 },
    );
    expect(result.status).toBe("completed");
    expect(result.requested).toBe(1); // ux only
    expect(result.received).toBe(1);
    const artifact = await deliveryStore.latest(JOB);
    expect(artifact?.summary.channelsNotConfigured).toBe(3);
    const byChannel = new Map(
      artifact?.reports[0]?.channels.map((c) => [c.channel, c]),
    );
    expect(byChannel.get("slack")?.codedError).toBe(
      DELIVER_GAP_CODES.slackTransportNotConfigured,
    );
    expect(byChannel.get("email")?.codedError).toBe(
      DELIVER_GAP_CODES.emailRecipientNotConfigured,
    );
    expect(byChannel.get("webhook")?.codedError).toBe(
      DELIVER_GAP_CODES.webhookUrlNotConfigured,
    );
    expect(byChannel.get("ux")?.status).toBe("delivered");
  });

  it("missing persisted input refuses by name, failed run recorded first", async () => {
    const generatedStore = new InMemoryGeneratedDatasetStore();
    const deliveryStore = new InMemoryDeliveryDatasetStore();
    const registry = buildDeliverJobRegistry(EMAIL_ENV);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 },
    );
    expect(result.status).toBe("failed");
    expect(result.codedError).toBe(DELIVER_JOB_CODES.inputMissing);
    expect(result.artifactId).toBeTruthy();
    const recorded = await deliveryStore.latest(JOB);
    expect(recorded?.run.status).toBe("failed");
    expect(recorded?.run.codedError).toBe(DELIVER_JOB_CODES.inputMissing);
    expect(spy.calls.slack).toHaveLength(0);
  });

  it("resume re-delivers only what did not complete — never twice", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const first = spySenders({
      webhook: async () => ({ ok: false, error: "hook down" }),
    });
    const r1 = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: first.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack", "webhook"] },
    );
    expect(r1.status).toBe("partial");
    expect(first.calls.slack).toHaveLength(1);
    expect(first.calls.webhook).toHaveLength(1);

    // The hook is back; a NEW run over the SAME generated copy
    // must skip slack (already delivered) and retry webhook.
    const second = spySenders();
    const r2 = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: second.senders },
      JOB,
      { runId: "deliver-2", nowMs: T0 + 120_000, channels: ["slack", "webhook"] },
    );
    expect(r2.status).toBe("completed");
    expect(r2.requested).toBe(2);
    expect(r2.received).toBe(2);
    expect(second.calls.slack).toHaveLength(0); // never delivered twice
    expect(second.calls.webhook).toHaveLength(1); // retried independently
    expect(
      r2.channelOutcomes.map((o) => `${o.channel}:${o.status}`),
    ).toEqual(["slack:already_delivered", "webhook:delivered"]);
    const artifact = await deliveryStore.latest(JOB);
    expect(artifact?.summary.channelsAlreadyDelivered).toBe(1);
    const slack = artifact?.reports[0]?.channels.find((c) => c.channel === "slack");
    expect(slack?.detail).toContain("deliver-1");
  });

  it("a new generated copy is a new delivery (resume is per input artifact)", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const first = spySenders();
    await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: first.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, channels: ["slack"] },
    );
    await generatedStore.store(generatedInput("gen-2", T0 + 3600_000));
    const second = spySenders();
    const r2 = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: second.senders },
      JOB,
      { runId: "deliver-2", nowMs: T0 + 3660_000, channels: ["slack"] },
    );
    expect(second.calls.slack).toHaveLength(1);
    expect(r2.channelOutcomes).toEqual([
      { reportKind: "analysis", channel: "slack", status: "delivered" },
    ]);
    expect(r2.inputRunId).toBe("gen-2");
  });

  it("shard pairKeys deliver only the partition's pairs", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000, pairKeys: ["analysis:slack"] },
    );
    expect(result.requested).toBe(1);
    expect(spy.calls.slack).toHaveLength(1);
    expect(spy.calls.email).toHaveLength(0);
    expect(spy.calls.webhook).toHaveLength(0);
    const artifact = await deliveryStore.latest(JOB);
    expect(artifact?.reports[0]?.channels.map((c) => c.channel)).toEqual(["slack"]);
  });

  it("a report with no generated formats contributes no pairs", async () => {
    const generatedStore = new InMemoryGeneratedDatasetStore();
    const seeded = generatedInput("gen-1", T0);
    seeded.reports[0]!.formats = seeded.reports[0]!.formats.map((f) => ({
      ...f,
      status: "failed" as const,
      bodyText: null,
      bodyBase64: null,
      codedError: "GENERATE_FORMAT_RENDER_FAILED",
    }));
    await generatedStore.store(seeded);
    const deliveryStore = new InMemoryDeliveryDatasetStore();
    const registry = buildDeliverJobRegistry(EMAIL_ENV);
    const spy = spySenders();
    const result = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000 },
    );
    expect(result.requested).toBe(0);
    expect(spy.calls.slack).toHaveLength(0);
  });

  it("an unknown job id throws by name; channel validation throws by name", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const err = await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: {} },
      "nope-deliver",
    ).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DeliverJobError);
    expect((err as DeliverJobError).code).toBe(DELIVER_JOB_CODES.jobNotFound);
    const channelErr = (() => {
      try {
        validateDeliverChannels(["slack", "pager"]);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(channelErr).toBeInstanceOf(DeliverJobError);
    expect((channelErr as DeliverJobError).code).toBe(
      DELIVER_JOB_CODES.channelUnknown,
    );
  });

  it("status: never-run, then ready with the snapshot's per-channel outcomes", async () => {
    const { generatedStore, deliveryStore, registry } = await seededWorld();
    const def = registry.get(JOB)!;
    const before = await buildDeliverStatus(deliveryStore, def, T0);
    expect(before.state).toBe("never-run");
    expect(before.lastRun).toBeNull();
    expect(before.snapshot).toBeNull();
    const spy = spySenders();
    await runDeliverJob(
      registry,
      { generatedStore, deliveryStore, senders: spy.senders },
      JOB,
      { runId: "deliver-1", nowMs: T0 + 60_000 },
    );
    const after = await buildDeliverStatus(deliveryStore, def, T0 + 120_000);
    expect(after.state).toBe("ready");
    expect(after.snapshot?.channelsDelivered).toBe(4);
    expect(after.snapshot?.inputRunId).toBe("gen-1");
    expect(after.snapshot?.reports[0]?.channels.map((c) => c.channel)).toEqual([
      "slack",
      "email",
      "webhook",
      "ux",
    ]);
    expect(after.snapshot?.stale).toBe(false);
  });
});

describe("createDeliverChannelSenders — the existing transports, composed (#3539)", () => {
  it("a bare env names every unconfigured transport", () => {
    const { senders, unconfiguredReasons } = createDeliverChannelSenders({});
    expect(senders.slack).toBeUndefined();
    expect(unconfiguredReasons.slack).toBe(
      DELIVER_GAP_CODES.slackTransportNotConfigured,
    );
    expect(senders.email).toBeUndefined();
    expect(unconfiguredReasons.email).toBe(
      DELIVER_GAP_CODES.emailTransportNotConfigured,
    );
    // The webhook sender exists (the dispatch service is
    // env-composed) but refuses per attempt without a URL,
    // then without its signing secret — never unsigned.
    expect(senders.webhook).toBeDefined();
  });

  it("the webhook sender refuses by name without a URL, then without a secret", async () => {
    const { senders } = createDeliverChannelSenders({});
    const noUrl = await senders.webhook!({ event: "pipeline.report", data: {} });
    expect(noUrl.ok).toBe(false);
    expect(noUrl.unconfiguredReason).toBe(DELIVER_GAP_CODES.webhookUrlNotConfigured);
    const { senders: withUrl } = createDeliverChannelSenders({
      OUTBOUND_WEBHOOK_URL: "https://hooks.example.com/in",
    });
    const noSecret = await withUrl.webhook!({
      event: "pipeline.report",
      data: {},
    });
    expect(noSecret.ok).toBe(false);
    expect(noSecret.unconfiguredReason).toBe(
      DELIVER_GAP_CODES.webhookSecretNotConfigured,
    );
  });

  it("a SLACK_WEBHOOK_URL env builds the slack sender over the unified seam", () => {
    const { senders, unconfiguredReasons } = createDeliverChannelSenders({
      SLACK_WEBHOOK_URL: "https://hooks.slack.com/services/x",
    });
    expect(senders.slack).toBeDefined();
    expect(unconfiguredReasons.slack).toBeUndefined();
  });
});
