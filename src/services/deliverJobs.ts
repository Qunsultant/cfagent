/**
 * Issue #3539 (Pipeline J6, epic #3533) — deliver jobs: the
 * contract, the registry, the channel dispatch, and the
 * run/read/status service. The final hand-off of the
 * pipeline: a deliver job reads the PERSISTED generated
 * dataset its generate job produced (with its provenance —
 * generatedDatasetPorts), delivers each report over the
 * configured channels, and persists the per-channel outcomes
 * (deliveryDatasetPorts) so a failed channel retries
 * independently and a resumed run re-delivers only what did
 * not complete.
 *
 * Where the channels live (the J6 composition rule, surveyed
 * against the existing machinery — this module composes the
 * platform's transports behind their existing seams and
 * builds NO parallel sender):
 * - Slack: the unified screener Slack sender
 *   (screenerSlackDelivery.deliverScreenerToSlack — cfpay A2A
 *   first, direct Web API / incoming-webhook fallback; a
 *   requested file that cannot be posted fails the delivery,
 *   #1216). Configuration: SLACK_BOT_TOKEN / SLACK_WEBHOOK_URL
 *   / SLACK_CHANNEL_ID / SCREENER_SLACK_CHANNEL in env, plus
 *   this job's optional channel override.
 * - Email: the platform's transports in the screening
 *   delivery's order — cfpay A2A email (cfpayA2A) when
 *   configured, else the one EmailSender port (emailSenderPorts
 *   / cloudflareEmailSender — the only EMAIL.send caller,
 *   #1778), which this stage uses for attachment-carrying
 *   mail. The recipient is configuration (a per-job knob or
 *   step param), validated by validateEmailRecipient exactly
 *   like research dispatch, and NEVER guessed.
 * - Webhook: the outbound webhook service
 *   (tradingWebhooks.ETradeWebhookService.dispatchOutboundWebhook
 *   — HMAC-SHA256 signed, SSRF-guarded; it refuses to send at
 *   all when no signing secret is configured, and that honest
 *   refusal is recorded per channel, never papered over).
 *   The target URL is configuration; the signing secret is
 *   env-only (OUTBOUND_WEBHOOK_SECRET) and never appears in
 *   any record — records carry the target's host only.
 * - UX surfaces: the generated artifact IS the UX data path —
 *   the Data Providers panel renders the generated copy from
 *   its store, and the Reports view renders the canonical
 *   mas_reports copy the generate run's canonical leg stored
 *   (where a host wired it). The ux channel therefore
 *   delivers by VERIFIED READ-BACK: the run re-reads the
 *   persisted generated copy through the same store port the
 *   panel's surface view reads, and records which surfaces
 *   hold the report (panel always; Reports view exactly when
 *   the input's canonical leg stored/deduped a row — named
 *   in the record, never assumed).
 *
 * Senders are injected (the screeningDelivery #1162 pattern):
 * production wiring builds them from env via
 * createDeliverChannelSenders; tests supply spies. A failing
 * channel never blocks the others, and every outcome is
 * recorded per (report, channel) pair.
 *
 * Honesty rules (the platform's, carried from
 * #3530/#3536/#3537/#3538):
 * - A read NEVER fetches and a delivery NEVER regenerates:
 *   the input is resolved from the generated-dataset store by
 *   the producing generate job's id — exact lineage.
 * - A channel that cannot be attempted in this residency
 *   (transport unconfigured, no recipient configured, no
 *   webhook URL or signing secret) is recorded not_configured
 *   with its coded reason — never a fake delivered state, and
 *   excluded from the run's requested tally (the generate
 *   stage's not_wired discipline).
 * - A missing persisted input refuses BY NAME
 *   (DELIVER_INPUT_MISSING, fail-closed): the failed run is
 *   recorded on the delivery store and returned, never a
 *   silent empty success.
 * - Resume never double-delivers: before any send, the run
 *   consults the delivery store for pairs an earlier run over
 *   the SAME generated artifact already delivered; those are
 *   recorded already_delivered (the sender is not called) and
 *   only the rest are attempted — so the engine's retry /
 *   resume re-runs the step safely. Every send ALSO claims
 *   its (runId, destination) pair through the ONE suppressor
 *   module (src/workflows/screenDeliverySuppression.ts,
 *   #3943) with an injected store — the screener's key
 *   space — so a re-run/replay with the same run id never
 *   re-sends even when the delivery dataset store cannot
 *   see the first run. A failed send releases its claim; a
 *   not-configured pair never claims; the ux channel is a
 *   read-back and never claims.
 *
 * Run outcomes are RETURNED, not thrown — the run record is
 * the job's state (the #3530 idiom). Only contract violations
 * throw (unknown job id — a caller bug; an unknown channel
 * name in configuration — a configuration bug).
 */
import { scrubFailureMessage, type DataProviderId, type IndexId } from "../trading";
import type {
  GeneratedDatasetArtifact,
  GeneratedDatasetStore,
  GeneratedReportRecord,
} from "../data/generatedDatasetPorts";
import {
  receivedChannelCount,
  type DeliveryChannelRecord,
  type DeliveryDatasetArtifact,
  type DeliveryDatasetStore,
  type DeliveryReportRecord,
} from "../data/deliveryDatasetPorts";
import { buildGenerateJobRegistry } from "./generateJobs";
import { deliverScreenerToSlack } from "./screenerSlackDelivery";
import { cfpaySendEmail, cfpaySendEmailWithAttachments, getCfpayConfig } from "./cfpayA2A";
import { createEmailSender } from "./cloudflareEmailSender";
import { validateEmailRecipient } from "../security/webhookReplay";
import { ETradeWebhookService } from "./tradingWebhooks";
import type { Env } from "../types";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";
import {
  createDeliverySuppressor,
  deliveryDestinationFor,
  deliverySuppressionKey,
  type DeliverySuppressor,
} from "../workflows/screenDeliverySuppression";

/** Module logger on the S2 structured-logging seam (#3515 S3 ratchet). */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "services/deliverJobs",
});

/** Stable coded errors for deliver-job outcomes (externalized vocabulary). */
export const DELIVER_JOB_CODES = {
  jobNotFound: "DELIVER_JOB_NOT_FOUND",
  inputMissing: "DELIVER_INPUT_MISSING",
  channelUnknown: "DELIVER_CHANNEL_UNKNOWN",
  allChannelsFailed: "DELIVER_ALL_CHANNELS_FAILED",
} as const;
export type DeliverJobCode = (typeof DELIVER_JOB_CODES)[keyof typeof DELIVER_JOB_CODES];

/** Stable log event code for a failed deliver run (codes + counts only). */
export const DELIVER_JOB_RUN_FAILED = "deliver_job_run_failed";

/** Coded reasons on per-channel records (externalized vocabulary). */
export const DELIVER_GAP_CODES = {
  /** No Slack transport is configured in this residency
   *  (no cfpay A2A, no SLACK_BOT_TOKEN, no SLACK_WEBHOOK_URL). */
  slackTransportNotConfigured: "slack_transport_not_configured",
  /** No email transport is configured in this residency
   *  (no cfpay A2A, no EMAIL binding). */
  emailTransportNotConfigured: "email_transport_not_configured",
  /** The deliver job names the email channel but no recipient
   *  is configured — delivery never guesses a recipient. */
  emailRecipientNotConfigured: "email_recipient_not_configured",
  /** No webhook target URL is configured (job config or
   *  OUTBOUND_WEBHOOK_URL). */
  webhookUrlNotConfigured: "webhook_url_not_configured",
  /** No outbound webhook signing secret is configured
   *  (OUTBOUND_WEBHOOK_SECRET): the signed dispatch refuses
   *  to send unsigned, by its own rule (#123). */
  webhookSecretNotConfigured: "webhook_signing_secret_not_configured",
  /** A sender was attempted and returned/threw a failure. */
  channelSendFailed: "DELIVER_CHANNEL_SEND_FAILED",
  /** The UX read-back found no readable generated copy. */
  uxSurfaceUnavailable: "DELIVER_UX_SURFACE_UNAVAILABLE",
} as const;

export class DeliverJobError extends Error {
  readonly code: DeliverJobCode;
  constructor(code: DeliverJobCode, message: string) {
    super(message);
    this.name = "DeliverJobError";
    this.code = code;
  }
}

/* ------------------------------------------------------------------ */
/* The channel vocabulary                                              */
/* ------------------------------------------------------------------ */

/**
 * The delivery channels a deliver job may use — the platform's
 * channels, each behind its existing seam (see the header):
 * slack (the unified screener sender), email (cfpay / the
 * EmailSender port), webhook (the signed outbound dispatch),
 * ux (the platform's own surfaces, by verified read-back).
 */
export const DELIVER_CHANNELS = ["slack", "email", "webhook", "ux"] as const;
export type DeliverChannel = (typeof DELIVER_CHANNELS)[number];

export const DELIVER_ALL_CHANNELS: readonly string[] = [...DELIVER_CHANNELS];

/** The default delivery configuration: every platform channel —
 *  a channel this residency cannot attempt records
 *  not_configured (named, visible), never a silent skip. */
export const DELIVER_DEFAULT_CHANNELS: readonly string[] = [...DELIVER_CHANNELS];

/** Validate a configured channel list; an unknown name is a
 *  configuration error, refused by name (never silently dropped). */
export function validateDeliverChannels(channels: readonly string[]): string[] {
  const out: string[] = [];
  for (const channel of channels) {
    if (!DELIVER_ALL_CHANNELS.includes(channel)) {
      throw new DeliverJobError(
        DELIVER_JOB_CODES.channelUnknown,
        `Unknown deliver channel "${channel}". Known channels: ${DELIVER_ALL_CHANNELS.join(", ")}.`,
      );
    }
    if (!out.includes(channel)) out.push(channel);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The channel senders (injected — the screeningDelivery pattern)      */
/* ------------------------------------------------------------------ */

/** One sender attempt's outcome. `unconfiguredReason` set ⇒ the
 *  channel could not be attempted (a configuration absence the
 *  service records as not_configured, not a send failure). */
export interface DeliverSenderResult {
  ok: boolean;
  error?: string;
  unconfiguredReason?: string;
  /** Non-secret target evidence for the record (the webhook
   *  target's host); other channels' targets are known to the
   *  service from configuration. */
  target?: string;
}

export interface DeliverChannelSenders {
  slack?: (input: {
    text: string;
    channel?: string;
    pdf?: { bytes: Uint8Array; fileName: string; title: string; comment: string };
  }) => Promise<DeliverSenderResult>;
  email?: (input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    attachment?: { fileName: string; contentType: string; contentBase64: string };
  }) => Promise<DeliverSenderResult>;
  webhook?: (input: {
    event: string;
    data: Record<string, unknown>;
    url?: string;
  }) => Promise<DeliverSenderResult>;
}

/**
 * Production senders over the existing transports, built from
 * env (the createScreeningDeliverySenders precedent, transposed
 * to this stage's residencies — no tenant ORM context: a
 * pipeline run is a system run). A channel whose transport
 * cannot be attempted from this environment is ABSENT from
 * `senders` and named in `unconfiguredReasons`; the underlying
 * services still fail honestly per attempt (e.g. the signed
 * webhook refuses without its secret — the factory surfaces
 * that as the webhook sender's own unconfiguredReason so the
 * record is coded, not prose-matched).
 */
export function createDeliverChannelSenders(env: Record<string, unknown>): {
  senders: DeliverChannelSenders;
  unconfiguredReasons: Partial<Record<DeliverChannel, string>>;
} {
  const senders: DeliverChannelSenders = {};
  const unconfiguredReasons: Partial<Record<DeliverChannel, string>> = {};
  const cfpay = getCfpayConfig(env);

  // Slack: the unified screener sender (A2A first, direct
  // fallback) — attemptable when any of its transports exists.
  if (cfpay || env.SLACK_BOT_TOKEN || env.SLACK_WEBHOOK_URL) {
    senders.slack = async ({ text, channel, pdf }) => {
      const r = await deliverScreenerToSlack(env, {
        text,
        ...(channel ? { channel } : {}),
        ...(pdf ? { pdf } : {}),
      });
      return { ok: r.ok, ...(r.error ? { error: r.error } : {}) };
    };
  } else {
    unconfiguredReasons.slack = DELIVER_GAP_CODES.slackTransportNotConfigured;
  }

  // Email: cfpay A2A first (the screening order), the
  // EmailSender port for attachment-carrying mail and as the
  // fallback transport.
  const emailPort = createEmailSender(env as never);
  if (cfpay || emailPort) {
    senders.email = async ({ to, subject, text, html, attachment }) => {
      const check = validateEmailRecipient(
        to,
        env.EMAIL_TO_ALLOWED_DOMAINS as string | undefined,
      );
      if (!check.ok) return { ok: false, error: check.reason ?? "Recipient not allowed." };
      if (attachment && emailPort) {
        const sent = await emailPort.send({
          to,
          subject,
          html,
          text,
          attachments: [
            {
              fileName: attachment.fileName,
              contentType: attachment.contentType,
              contentBase64: attachment.contentBase64,
            },
          ],
        });
        return sent
          ? { ok: true }
          : { ok: false, error: "The EmailSender port reported a send failure." };
      }
      if (cfpay) {
        const r = attachment
          ? await cfpaySendEmailWithAttachments(cfpay, {
              to,
              subject,
              body: text,
              attachments: [
                {
                  filename: attachment.fileName,
                  contentB64: attachment.contentBase64,
                  contentType: attachment.contentType,
                },
              ],
            })
          : await cfpaySendEmail(cfpay, to, subject, text);
        if (r.ok) return { ok: true };
        if (!emailPort) return { ok: false, error: r.error ?? "cfpay email delivery failed." };
      }
      if (emailPort) {
        const sent = await emailPort.send({ to, subject, html, text });
        return sent
          ? { ok: true }
          : { ok: false, error: "The EmailSender port reported a send failure." };
      }
      return {
        ok: false,
        error: "No email transport completed the delivery.",
      };
    };
  } else {
    unconfiguredReasons.email = DELIVER_GAP_CODES.emailTransportNotConfigured;
  }

  // Webhook: the signed outbound dispatch. URL and secret are
  // resolved per attempt (job configuration first, env
  // fallback); their absence is a coded unconfiguredReason —
  // the dispatch itself is never attempted unsigned or
  // target-less.
  senders.webhook = async ({ event, data, url }) => {
    const target = url ?? (env.OUTBOUND_WEBHOOK_URL as string | undefined);
    if (!target) {
      return { ok: false, unconfiguredReason: DELIVER_GAP_CODES.webhookUrlNotConfigured };
    }
    if (!env.OUTBOUND_WEBHOOK_SECRET) {
      return { ok: false, unconfiguredReason: DELIVER_GAP_CODES.webhookSecretNotConfigured };
    }
    let host: string | undefined;
    try {
      host = new URL(target).host;
    } catch {
      host = undefined;
    }
    const service = new ETradeWebhookService(undefined, env as unknown as Env);
    const r = await service.dispatchOutboundWebhook(event, data, target);
    return r.success
      ? { ok: true, ...(host ? { target: host } : {}) }
      : { ok: false, error: r.error ?? `Webhook dispatch failed (status ${r.status ?? "n/a"}).` };
  };

  return { senders, unconfiguredReasons };
}

/* ------------------------------------------------------------------ */
/* The contract + registry                                             */
/* ------------------------------------------------------------------ */

/**
 * The deliver-job contract: the generate job whose persisted
 * dataset it consumes, the channels it delivers over (with
 * their configured targets), and its cadence/freshness knobs
 * (config-resolved, see buildDeliverJobRegistry — never
 * literals at call sites).
 */
export interface DeliverJobDefinition {
  id: string;
  /** The generate job whose persisted dataset is the input. */
  generateJobId: string;
  /** The analyze job upstream of the generate job. */
  analyzeJobId: string;
  /** The enrich job upstream of the analyze job. */
  enrichJobId: string;
  /** The feed job at the head of this job's lineage. */
  feedJobId: string;
  sourceId: DataProviderId;
  /** The dataset id within the source ("quotes"). */
  dataset: string;
  universe: { kind: "index"; index: IndexId; label: string };
  /** The channels this job delivers over by default (the
   *  pipeline definition's step params may override). */
  channels: readonly string[];
  /** Slack channel override; null ⇒ the sender's env default. */
  slackChannel: string | null;
  /** Email recipient; null ⇒ the email channel records
   *  not_configured (a recipient is never guessed). */
  emailTo: string | null;
  /** Webhook target URL; null ⇒ the dispatch's env fallback. */
  webhookUrl: string | null;
  /** Declared cadence — the scheduling slice's input. */
  cadenceMinutes: number;
  /** Age past which the stored delivery copy is labelled stale. */
  staleAfterMinutes: number;
}

/**
 * The deliver-job registry — the GenerateJobRegistry idiom
 * (unique ids, re-registering throws so provenance ids stay
 * unambiguous; explicit resolution failure, no silent fallback).
 */
export class DeliverJobRegistry {
  private jobs = new Map<string, DeliverJobDefinition>();

  register(job: DeliverJobDefinition): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Deliver job "${job.id}" is already registered.`);
    }
    this.jobs.set(job.id, job);
  }

  get(id: string): DeliverJobDefinition | undefined {
    return this.jobs.get(id);
  }

  list(): DeliverJobDefinition[] {
    return Array.from(this.jobs.values());
  }

  /** The deliver job consuming a generate job's dataset, if one is registered. */
  forGenerateJob(generateJobId: string): DeliverJobDefinition | undefined {
    return this.list().find((j) => j.generateJobId === generateJobId);
  }
}

/* ------------------------------------------------------------------ */
/* Cadence / freshness / channel knobs — config, not literals.         */
/* DELIVER_JOB_<JOB_ID>_CADENCE_MINUTES / _STALE_MINUTES /             */
/* _CHANNELS / _SLACK_CHANNEL / _EMAIL_TO / _WEBHOOK_URL               */
/* ------------------------------------------------------------------ */

function knobKey(jobId: string, suffix: string): string {
  return `DELIVER_JOB_${jobId.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_${suffix}`;
}

function resolveMinutesKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  suffix: string,
  fallback: number,
): number {
  const raw = env[knobKey(jobId, suffix)];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveStringKnob(
  env: Record<string, string | undefined>,
  jobId: string,
  suffix: string,
): string | null {
  const raw = env[knobKey(jobId, suffix)];
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function resolveChannelsKnob(
  env: Record<string, string | undefined>,
  jobId: string,
): string[] {
  const raw = env[knobKey(jobId, "CHANNELS")];
  if (typeof raw !== "string" || !raw.trim()) return [...DELIVER_DEFAULT_CHANNELS];
  return validateDeliverChannels(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

export const DELIVER_JOB_DEFAULTS = {
  cadenceMinutes: 60,
  staleAfterMinutes: 180,
} as const;

/**
 * The built-in registry: one deliver job per generate job in
 * the J5 registry (which is one per analyze job, one per
 * enrich job, one per quotes feed job). The job id extends
 * the lineage: <feed job>-enrich-analyze-generate-deliver.
 */
export function buildDeliverJobRegistry(
  env: Record<string, string | undefined>,
): DeliverJobRegistry {
  const generateRegistry = buildGenerateJobRegistry(env);
  const registry = new DeliverJobRegistry();
  for (const generate of generateRegistry.list()) {
    const id = `${generate.id}-deliver`;
    registry.register({
      id,
      generateJobId: generate.id,
      analyzeJobId: generate.analyzeJobId,
      enrichJobId: generate.enrichJobId,
      feedJobId: generate.feedJobId,
      sourceId: generate.sourceId,
      dataset: generate.dataset,
      universe: generate.universe,
      channels: resolveChannelsKnob(env, id),
      slackChannel: resolveStringKnob(env, id, "SLACK_CHANNEL"),
      emailTo: resolveStringKnob(env, id, "EMAIL_TO"),
      webhookUrl: resolveStringKnob(env, id, "WEBHOOK_URL"),
      cadenceMinutes: resolveMinutesKnob(
        env,
        id,
        "CADENCE_MINUTES",
        DELIVER_JOB_DEFAULTS.cadenceMinutes,
      ),
      staleAfterMinutes: resolveMinutesKnob(
        env,
        id,
        "STALE_MINUTES",
        DELIVER_JOB_DEFAULTS.staleAfterMinutes,
      ),
    });
  }
  return registry;
}

/* ------------------------------------------------------------------ */
/* The run                                                             */
/* ------------------------------------------------------------------ */

export interface DeliverJobDeps {
  /** The generated-dataset store (the input copies). */
  generatedStore: GeneratedDatasetStore;
  /** The delivery-dataset store (this stage's persisted output). */
  deliveryStore: DeliveryDatasetStore;
  /** The channel senders for this residency (injected). */
  senders: DeliverChannelSenders;
  /** Per-channel coded reasons a sender could not be built
   *  (createDeliverChannelSenders' second return). */
  unconfiguredReasons?: Partial<Record<DeliverChannel, string>>;
  /**
   * The duplicate-delivery suppressor for this residency
   * (#3943): the ONE module (screenDeliverySuppression),
   * injected with the residency's store — the host injects
   * the durable mas_delivery_claims store, the workflow
   * residency an in-memory suppressor. Absent ⇒ a fresh
   * in-memory suppressor (the screener executor's fallback
   * idiom): claims then hold only for this run.
   */
  suppressor?: DeliverySuppressor;
}

export interface RunDeliverJobOptions {
  trigger?: "manual" | "scheduled";
  /** The run id to record under (the pipeline engine's run id,
   *  when dispatched through the plane — one run, one id). */
  runId?: string;
  /** Injectable clock (tests); defaults to now. */
  nowMs?: number;
  /** Channel override (the pipeline definition's configured
   *  params win over the registry defaults). */
  channels?: readonly string[];
  /** Target overrides (configuration, same rule). */
  slackChannel?: string | null;
  emailTo?: string | null;
  webhookUrl?: string | null;
  /**
   * Shard partition: deliver only these (report × channel)
   * pair keys ("<report kind>:<channel>") of the run's full
   * pair set (the plane's sharded shape — the pair list is
   * computed from the persisted input, so partitions and the
   * whole-input run can never disagree on membership).
   */
  pairKeys?: readonly string[];
}

export interface DeliverRunResult {
  jobId: string;
  runId: string;
  status: "completed" | "partial" | "failed";
  artifactId: string | null;
  /** (Report × channel) pairs the run set out to deliver
   *  (not_configured pairs excluded — see the store's rule). */
  requested: number;
  /** Pairs whose delivery exists (this run's + already-delivered). */
  received: number;
  failed: number;
  codedError: string | null;
  errorMessage: string | null;
  /** The generated artifact consumed (lineage), when one was. */
  inputArtifactId: string | null;
  inputRunId: string | null;
  /** Reports with at least one delivered channel. */
  reportsDelivered: string[];
  /** Per-pair outcomes, in delivery order. */
  channelOutcomes: Array<{
    reportKind: string;
    channel: string;
    status: DeliveryChannelRecord["status"];
  }>;
}

/** The deterministic pair key for one (report, channel) pair. */
export function deliverPairKey(reportKind: string, channel: string): string {
  return `${reportKind}:${channel}`;
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** The report's deliverable content, from the persisted
 *  generated artifact alone: the text body a channel carries
 *  (markdown preferred, then json, then a deterministic
 *  lineage summary), the pdf attachment when one was
 *  generated, and the formats actually available. */
function reportContent(report: GeneratedReportRecord): {
  text: string;
  textFormat: string | null;
  pdf: { bytes: Uint8Array; base64: string; fileName: string } | null;
  formats: string[];
} {
  const generated = report.formats.filter((f) => f.status === "generated");
  const formats = generated.map((f) => f.format);
  const markdown = generated.find((f) => f.format === "markdown" && f.bodyText !== null);
  const json = generated.find((f) => f.format === "json" && f.bodyText !== null);
  const anyText = generated.find((f) => f.bodyText !== null);
  const textRecord = markdown ?? json ?? anyText;
  const pdfRecord = generated.find((f) => f.format === "pdf" && f.bodyBase64 !== null);
  return {
    text: textRecord?.bodyText ?? report.title,
    textFormat: textRecord?.format ?? null,
    pdf: pdfRecord
      ? {
          bytes: base64ToBytes(pdfRecord.bodyBase64!),
          base64: pdfRecord.bodyBase64!,
          fileName: `${report.kind}.pdf`,
        }
      : null,
    formats,
  };
}

const scrubbed = (err: unknown): string =>
  scrubFailureMessage(err instanceof Error ? err.message : String(err));

/**
 * Run one deliver job: resolve the persisted generated input,
 * deliver each of its reports over the configured channels
 * (skipping pairs an earlier run over the same input already
 * delivered), persist the delivery artifact. Every send ALSO
 * claims its (runId, destination) pair through the ONE
 * suppressor module with the injected store (#3943) — a
 * re-run/replay with the same run id never re-sends.
 * Outcomes are RETURNED (the failed-input run is recorded
 * first); only an unknown job id throws (a caller bug, the
 * #3530 idiom).
 */
export async function runDeliverJob(
  registry: DeliverJobRegistry,
  deps: DeliverJobDeps,
  jobId: string,
  opts: RunDeliverJobOptions = {},
): Promise<DeliverRunResult> {
  const def = registry.get(jobId);
  if (!def) {
    throw new DeliverJobError(
      DELIVER_JOB_CODES.jobNotFound,
      `Deliver job "${jobId}" is not registered.`,
    );
  }
  const startedMs = opts.nowMs ?? Date.now();
  const startedAt = new Date(startedMs).toISOString();
  const runId = opts.runId ?? `deliver-run-${crypto.randomUUID()}`;
  const trigger = opts.trigger ?? "manual";
  const channels = validateDeliverChannels(opts.channels ?? def.channels);
  const slackChannel = opts.slackChannel !== undefined ? opts.slackChannel : def.slackChannel;
  const emailTo = opts.emailTo !== undefined ? opts.emailTo : def.emailTo;
  const webhookUrl = opts.webhookUrl !== undefined ? opts.webhookUrl : def.webhookUrl;
  const pairFilter = opts.pairKeys ? new Set(opts.pairKeys) : null;
  // The duplicate-delivery suppressor for this run (#3943):
  // the one module, injected store. Absent ⇒ a fresh
  // in-memory suppressor — claims then hold only for this
  // run (the screener executor's fallback idiom).
  const suppressor = deps.suppressor ?? createDeliverySuppressor();

  const finish = async (
    partial: Omit<
      DeliverRunResult,
      "jobId" | "runId" | "artifactId" | "inputArtifactId" | "inputRunId" | "reportsDelivered" | "channelOutcomes"
    > & {
      reports: DeliveryReportRecord[];
      inputArtifact: GeneratedDatasetArtifact | undefined;
    },
  ): Promise<DeliverRunResult> => {
    const finishedAt = new Date(opts.nowMs ?? Date.now()).toISOString();
    const summary: DeliveryDatasetArtifact["summary"] = {
      reportsDelivered: partial.reports.filter((r) =>
        r.channels.some((c) => c.status === "delivered" || c.status === "already_delivered"),
      ).length,
      channelsDelivered: partial.reports.reduce(
        (sum, r) => sum + r.channels.filter((c) => c.status === "delivered").length,
        0,
      ),
      channelsAlreadyDelivered: partial.reports.reduce(
        (sum, r) => sum + r.channels.filter((c) => c.status === "already_delivered").length,
        0,
      ),
      channelsFailed: partial.reports.reduce(
        (sum, r) => sum + r.channels.filter((c) => c.status === "failed").length,
        0,
      ),
      channelsNotConfigured: partial.reports.reduce(
        (sum, r) => sum + r.channels.filter((c) => c.status === "not_configured").length,
        0,
      ),
    };
    const artifact = await deps.deliveryStore.store({
      jobId: def.id,
      generateJobId: def.generateJobId,
      analyzeJobId: def.analyzeJobId,
      enrichJobId: def.enrichJobId,
      feedJobId: def.feedJobId,
      sourceId: def.sourceId,
      dataset: def.dataset,
      universe: partial.inputArtifact?.universe ?? {
        kind: "index",
        index: def.universe.index,
        label: def.universe.label,
        snapshotDate: null,
        sourceLabel: null,
        size: 0,
      },
      inputArtifactId: partial.inputArtifact?.id ?? "",
      inputRunId: partial.inputArtifact?.run.runId ?? "",
      inputAsOf: partial.inputArtifact?.createdAt ?? "",
      channelsRequested: channels,
      reports: partial.reports,
      summary,
      run: {
        runId,
        trigger,
        startedAt,
        finishedAt,
        status: partial.status,
        requested: partial.requested,
        received: partial.received,
        failed: partial.failed,
        codedError: partial.codedError,
        errorMessage: partial.errorMessage,
      },
      nowIso: finishedAt,
    });
    if (partial.status === "failed") {
      structuredLog.warn(DELIVER_JOB_RUN_FAILED, {
        message: `[deliverJobs] ${partial.codedError ?? "DELIVER_RUN_FAILED"}: deliver job "${def.id}" run ${runId} failed (${partial.errorMessage ?? "no detail"})`,
        jobId: def.id,
        runId,
        codedError: partial.codedError,
      });
    }
    return {
      jobId: def.id,
      runId,
      status: partial.status,
      artifactId: artifact.id,
      requested: partial.requested,
      received: partial.received,
      failed: partial.failed,
      codedError: partial.codedError,
      errorMessage: partial.errorMessage,
      inputArtifactId: partial.inputArtifact?.id ?? null,
      inputRunId: partial.inputArtifact?.run.runId ?? null,
      reportsDelivered: partial.reports
        .filter((r) =>
          r.channels.some((c) => c.status === "delivered" || c.status === "already_delivered"),
        )
        .map((r) => r.kind),
      channelOutcomes: partial.reports.flatMap((r) =>
        r.channels.map((c) => ({ reportKind: r.kind, channel: c.channel, status: c.status })),
      ),
    };
  };

  // The input: the generate job's newest USABLE persisted
  // artifact, by its exact job id — reads never fetch and
  // delivery never regenerates.
  const inputArtifact = await deps.generatedStore.latestUsable(def.generateJobId);
  if (!inputArtifact) {
    return finish({
      status: "failed",
      requested: 0,
      received: 0,
      failed: 0,
      codedError: DELIVER_JOB_CODES.inputMissing,
      errorMessage: scrubFailureMessage(
        `No usable persisted generated dataset for generate job "${def.generateJobId}": the deliver run was refused rather than fetching live or delivering another job's copy.`,
      ),
      reports: [],
      inputArtifact: undefined,
    });
  }

  // Resume state: the pairs earlier runs over THIS input
  // already delivered (the sender is never called for them
  // again — a completed channel is never delivered twice for
  // the same generated copy).
  const priorArtifacts = await deps.deliveryStore.listForInput(def.id, inputArtifact.id);
  const alreadyDelivered = new Map<string, { runId: string; target: string | null }>();
  for (const prior of priorArtifacts) {
    for (const report of prior.reports) {
      for (const channel of report.channels) {
        if (channel.status === "delivered") {
          const key = deliverPairKey(report.kind, channel.channel);
          if (!alreadyDelivered.has(key)) {
            alreadyDelivered.set(key, { runId: prior.run.runId, target: channel.target });
          }
        }
      }
    }
  }

  const deliveredReports: DeliveryReportRecord[] = [];
  let requested = 0;
  let received = 0;
  let failed = 0;
  const failureMessages: string[] = [];

  for (const report of inputArtifact.reports) {
    const content = reportContent(report);
    if (content.formats.length === 0) {
      // Nothing was generated for this report (its format
      // failures are recorded on the input artifact itself);
      // it contributes no delivery pairs.
      continue;
    }
    const channelRecords: DeliveryChannelRecord[] = [];
    for (const channel of channels) {
      const pairKey = deliverPairKey(report.kind, channel);
      if (pairFilter && !pairFilter.has(pairKey)) continue;
      const prior = alreadyDelivered.get(pairKey);
      if (prior) {
        channelRecords.push({
          channel,
          status: "already_delivered",
          target: prior.target,
          formats: content.formats,
          codedError: null,
          errorMessage: null,
          detail: `Delivered by run ${prior.runId} over this generated copy; not sent again.`,
        });
        requested++;
        received++;
        continue;
      }
      const record = await deliverOneChannel({
        channel: channel as DeliverChannel,
        def,
        report,
        content,
        inputArtifact,
        deps,
        suppressor,
        runId,
        slackChannel,
        emailTo,
        webhookUrl,
      });
      channelRecords.push(record);
      if (record.status === "delivered") {
        requested++;
        received++;
      } else if (record.status === "already_delivered") {
        // A suppressor-held pair counts as received, like a
        // store-held pair above: the recipient already holds
        // the report.
        requested++;
        received++;
      } else if (record.status === "failed") {
        requested++;
        failed++;
        failureMessages.push(
          `${report.kind}/${channel}: ${record.errorMessage ?? record.codedError ?? "failed"}`,
        );
      }
      // not_configured pairs are recorded but excluded from
      // the requested tally (the header's discipline).
    }
    if (channelRecords.length > 0) {
      deliveredReports.push({ kind: report.kind, title: report.title, channels: channelRecords });
    }
  }

  const allFailed = requested > 0 && received === 0;
  return finish({
    status: allFailed ? "failed" : failed > 0 || (requested === 0 && deliveredReports.length > 0) ? "partial" : "completed",
    requested,
    received,
    failed,
    codedError: allFailed ? DELIVER_JOB_CODES.allChannelsFailed : null,
    errorMessage: allFailed
      ? scrubFailureMessage(
          `Every attempted channel failed for deliver job "${def.id}": ${failureMessages.join("; ")}`,
        )
      : null,
    reports: deliveredReports,
    inputArtifact,
  });
}

/** Attempt one (report, channel) pair and build its record.
 *  Never throws: a sender throw is that channel's failure. */
async function deliverOneChannel(args: {
  channel: DeliverChannel;
  def: DeliverJobDefinition;
  report: GeneratedReportRecord;
  content: ReturnType<typeof reportContent>;
  inputArtifact: GeneratedDatasetArtifact;
  deps: DeliverJobDeps;
  /** The one suppressor module, injected store (#3943). */
  suppressor: DeliverySuppressor;
  /** This deliver run's id — the claim's run id. */
  runId: string;
  slackChannel: string | null;
  emailTo: string | null;
  webhookUrl: string | null;
}): Promise<DeliveryChannelRecord> {
  const { channel, def, report, content, inputArtifact, deps, suppressor, runId } = args;
  const base = { channel, formats: content.formats };
  const notConfigured = (codedError: string, errorMessage: string): DeliveryChannelRecord => ({
    ...base,
    status: "not_configured",
    target: null,
    codedError,
    errorMessage,
    detail: null,
  });
  const failedRecord = (errorMessage: string): DeliveryChannelRecord => ({
    ...base,
    status: "failed",
    target: null,
    codedError: DELIVER_GAP_CODES.channelSendFailed,
    errorMessage: scrubbed(errorMessage),
    detail: null,
  });
  /**
   * Claim this pair's (runId, destination) before sending
   * (#3943): the screener's key space, one module. A held
   * claim ⇒ already_delivered — the sender is never called.
   * The claim is taken ONLY here, after every
   * not-configured early-return, so a pair that cannot be
   * attempted never claims; a send that does not happen
   * (failed, or unconfiguredReason) releases it below.
   */
  const suppressedRecord = (
    destination: string,
    target: string | null,
  ): DeliveryChannelRecord | null => {
    if (suppressor.tryClaim(runId, destination)) return null;
    return {
      ...base,
      status: "already_delivered",
      target,
      formats: content.formats,
      codedError: null,
      errorMessage: null,
      detail: `Suppressed by delivery claim ${deliverySuppressionKey(runId, destination)} (already claimed by an earlier send); not sent again.`,
    };
  };

  if (channel === "ux") {
    // Verified read-back through the same store port the
    // panel's surface view reads (see the header): the
    // generated copy must be readable on the UX data path.
    try {
      const current = await deps.generatedStore.latestUsable(def.generateJobId);
      if (!current) {
        return {
          ...base,
          status: "failed",
          target: "ux",
          codedError: DELIVER_GAP_CODES.uxSurfaceUnavailable,
          errorMessage:
            "The generated copy is not readable on the UX data path (no usable generated artifact); nothing was surfaced.",
          detail: null,
        };
      }
      const surfaces = ["Data Providers panel (generated copy)"];
      if (report.canonical.status === "stored" || report.canonical.status === "deduped") {
        surfaces.push("Reports view (canonical copy)");
      }
      return {
        ...base,
        status: "delivered",
        target: "ux",
        codedError: null,
        errorMessage: null,
        detail: `Surfaces: ${surfaces.join("; ")}.${
          report.canonical.status === "not_wired"
            ? " Reports view: canonical copy not stored — the generate run recorded its canonical leg not_wired."
            : ""
        }`,
      };
    } catch (err) {
      return {
        ...base,
        status: "failed",
        target: "ux",
        codedError: DELIVER_GAP_CODES.uxSurfaceUnavailable,
        errorMessage: scrubbed(err),
        detail: null,
      };
    }
  }

  if (channel === "slack") {
    const sender = deps.senders.slack;
    if (!sender) {
      return notConfigured(
        deps.unconfiguredReasons?.slack ?? DELIVER_GAP_CODES.slackTransportNotConfigured,
        "No Slack transport is configured in this residency (no cfpay A2A, no SLACK_BOT_TOKEN, no SLACK_WEBHOOK_URL); the delivery was not attempted.",
      );
    }
    const slackDestination = deliveryDestinationFor("slack");
    const suppressed = suppressedRecord(slackDestination, args.slackChannel ?? null);
    if (suppressed) return suppressed;
    try {
      const r = await sender({
        text: content.text,
        ...(args.slackChannel ? { channel: args.slackChannel } : {}),
        ...(content.pdf
          ? {
              pdf: {
                bytes: content.pdf.bytes,
                fileName: content.pdf.fileName,
                title: report.title,
                comment: report.title,
              },
            }
          : {}),
      });
      if (r.unconfiguredReason) {
        suppressor.release(runId, slackDestination);
        return notConfigured(r.unconfiguredReason, r.error ?? r.unconfiguredReason);
      }
      if (!r.ok) {
        suppressor.release(runId, slackDestination);
        return failedRecord(r.error ?? "Slack delivery failed.");
      }
      return {
        ...base,
        status: "delivered",
        target: args.slackChannel ?? null,
        formats: content.pdf
          ? [...(content.textFormat ? [content.textFormat] : []), "pdf"]
          : content.textFormat
            ? [content.textFormat]
            : [],
        codedError: null,
        errorMessage: null,
        detail: null,
      };
    } catch (err) {
      suppressor.release(runId, slackDestination);
      return failedRecord(scrubbed(err));
    }
  }

  if (channel === "email") {
    if (!args.emailTo) {
      return notConfigured(
        DELIVER_GAP_CODES.emailRecipientNotConfigured,
        "The deliver job names the email channel but no recipient is configured; delivery never guesses a recipient.",
      );
    }
    const sender = deps.senders.email;
    if (!sender) {
      return notConfigured(
        deps.unconfiguredReasons?.email ?? DELIVER_GAP_CODES.emailTransportNotConfigured,
        "No email transport is configured in this residency (no cfpay A2A, no EMAIL binding); the delivery was not attempted.",
      );
    }
    const emailDestination = deliveryDestinationFor("email", args.emailTo);
    const suppressed = suppressedRecord(emailDestination, args.emailTo);
    if (suppressed) return suppressed;
    try {
      const html = `<p>${content.text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/\n/g, "<br/>")}</p>`;
      const r = await sender({
        to: args.emailTo,
        subject: report.title,
        text: content.text,
        html,
        ...(content.pdf
          ? {
              attachment: {
                fileName: content.pdf.fileName,
                contentType: "application/pdf",
                contentBase64: content.pdf.base64,
              },
            }
          : {}),
      });
      if (r.unconfiguredReason) {
        suppressor.release(runId, emailDestination);
        return notConfigured(r.unconfiguredReason, r.error ?? r.unconfiguredReason);
      }
      if (!r.ok) {
        suppressor.release(runId, emailDestination);
        return failedRecord(r.error ?? "Email delivery failed.");
      }
      return {
        ...base,
        status: "delivered",
        target: args.emailTo,
        formats: content.pdf
          ? [...(content.textFormat ? [content.textFormat] : []), "pdf"]
          : content.textFormat
            ? [content.textFormat]
            : [],
        codedError: null,
        errorMessage: null,
        detail: null,
      };
    } catch (err) {
      suppressor.release(runId, emailDestination);
      return failedRecord(scrubbed(err));
    }
  }

  // webhook
  const sender = deps.senders.webhook;
  if (!sender) {
    return notConfigured(
      deps.unconfiguredReasons?.webhook ?? DELIVER_GAP_CODES.webhookUrlNotConfigured,
      "No webhook sender is configured in this residency; the delivery was not attempted.",
    );
  }
  const webhookDestination = deliveryDestinationFor("webhook");
  const suppressed = suppressedRecord(webhookDestination, null);
  if (suppressed) return suppressed;
  try {
    const r = await sender({
      event: "pipeline.report",
      data: {
        deliverJobId: def.id,
        generateJobId: def.generateJobId,
        reportKind: report.kind,
        title: report.title,
        formats: content.formats,
        generatedArtifactId: inputArtifact.id,
        generatedRunId: inputArtifact.run.runId,
        ...(content.textFormat === "json" ? { report: safeJson(content.text) } : { text: content.text }),
      },
      ...(args.webhookUrl ? { url: args.webhookUrl } : {}),
    });
    if (r.unconfiguredReason) {
      suppressor.release(runId, webhookDestination);
      return notConfigured(r.unconfiguredReason, r.error ?? r.unconfiguredReason);
    }
    if (!r.ok) {
      suppressor.release(runId, webhookDestination);
      return failedRecord(r.error ?? "Webhook dispatch failed.");
    }
    return {
      ...base,
      status: "delivered",
      target: r.target ?? null,
      formats: ["json"],
      codedError: null,
      errorMessage: null,
      detail: null,
    };
  } catch (err) {
    suppressor.release(runId, webhookDestination);
    return failedRecord(scrubbed(err));
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/* ------------------------------------------------------------------ */
/* Status — what the UX renders (one source of truth: the store)       */
/* ------------------------------------------------------------------ */

export interface DeliverStatusView {
  jobId: string;
  generateJobId: string;
  analyzeJobId: string;
  enrichJobId: string;
  feedJobId: string;
  sourceId: DataProviderId;
  dataset: string;
  channels: string[];
  slackChannel: string | null;
  emailTo: string | null;
  webhookUrl: string | null;
  universeLabel: string;
  cadenceMinutes: number;
  staleAfterMinutes: number;
  state: "never-run" | "ready";
  lastRun: DeliveryDatasetArtifact["run"] | null;
  /** Recent run history, newest first. */
  history: DeliveryDatasetArtifact["run"][];
  snapshot: {
    artifactId: string;
    asOf: string;
    ageSeconds: number;
    /** Reports with at least one delivered channel. */
    reportsDelivered: number;
    /** Channel pairs whose delivery exists (incl. already-delivered). */
    channelsDelivered: number;
    stale: boolean;
    /** Lineage: the generated artifact + run this copy derives from. */
    inputArtifactId: string;
    inputRunId: string;
    inputAsOf: string;
    /** Per-report outcomes: each channel's status + target. */
    reports: Array<{
      kind: string;
      title: string;
      channels: Array<{
        channel: string;
        status: DeliveryChannelRecord["status"];
        target: string | null;
      }>;
    }>;
  } | null;
}

export async function buildDeliverStatus(
  store: DeliveryDatasetStore,
  def: DeliverJobDefinition,
  nowMs: number,
): Promise<DeliverStatusView> {
  const [latest, usable, runArtifacts] = await Promise.all([
    store.latest(def.id),
    store.latestUsable(def.id),
    store.listRuns(def.id, 5),
  ]);
  const base: DeliverStatusView = {
    jobId: def.id,
    generateJobId: def.generateJobId,
    analyzeJobId: def.analyzeJobId,
    enrichJobId: def.enrichJobId,
    feedJobId: def.feedJobId,
    sourceId: def.sourceId,
    dataset: def.dataset,
    channels: [...def.channels],
    slackChannel: def.slackChannel,
    emailTo: def.emailTo,
    webhookUrl: def.webhookUrl,
    universeLabel: def.universe.label,
    cadenceMinutes: def.cadenceMinutes,
    staleAfterMinutes: def.staleAfterMinutes,
    state: latest ? "ready" : "never-run",
    lastRun: latest?.run ?? null,
    history: runArtifacts.map((a) => a.run),
    snapshot: null,
  };
  if (!usable) return base;
  const asOfMs = Date.parse(usable.createdAt);
  const ageSeconds = Number.isNaN(asOfMs)
    ? 0
    : Math.max(0, Math.floor((nowMs - asOfMs) / 1000));
  return {
    ...base,
    snapshot: {
      artifactId: usable.id,
      asOf: usable.createdAt,
      ageSeconds,
      reportsDelivered: usable.summary.reportsDelivered,
      channelsDelivered: receivedChannelCount(usable),
      stale: ageSeconds > def.staleAfterMinutes * 60,
      inputArtifactId: usable.inputArtifactId,
      inputRunId: usable.inputRunId,
      inputAsOf: usable.inputAsOf,
      reports: usable.reports.map((r) => ({
        kind: r.kind,
        title: r.title,
        channels: r.channels.map((c) => ({
          channel: c.channel,
          status: c.status,
          target: c.target,
        })),
      })),
    },
  };
}
