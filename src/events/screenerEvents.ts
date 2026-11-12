/**
 * Issue #210: Event-driven screener — pub/sub event bus.
 *
 * When the Autonomous Market Screen completes (or fails), it publishes a
 * typed event instead of only broadcasting to a WebSocket nobody listens
 * to. Subscribers (Slack, email, webhook publishers in
 * ./screenerPublishers.ts) react to the event and harvest the value.
 *
 * The bus is intentionally simple: synchronous in-process pub/sub within
 * the Durable Object. Subscribers are independent — a failure in one
 * never blocks the others.
 *
 * Issue #1770 (slice C) — LOSS WINDOW, READ BEFORE RELYING ON THIS BUS:
 * The in-process bus is NOT the durable delivery path. Since #1739 the
 * durable primary for screener.completed / screener.failed is the
 * Cloudflare Queue (screener-events-delivery, CloudEvents envelopes,
 * dedup), which survives Worker isolate and instance restarts; the
 * in-process bus runs only as fallback (queue unreachable, or no
 * subscriber stream received the event) and as local fan-out.
 *   - Fallback-leg window: an event published to this bus is lost if
 *     the isolate / Durable Object instance restarts (or a new
 *     instance serves) before every subscriber's handler completes.
 *     There is no persistence, no replay, and no redelivery — the
 *     window opens at bus publish and closes when the last handler
 *     returns; anything in flight across a restart is gone, leaving
 *     only the publisher's console warning (queue-fallback notice)
 *     as evidence.
 *   - options.* events have NO durable leg at all: they keep the
 *     legacy bus path (no bus subscribers today; delivery stays on
 *     the #223 direct path), so their loss window is the same
 *     in-process window with no queue behind it.
 *   - What survives a lost delivery: the screener-loop outcome record.
 *     Since #1770 slice C the publish path also writes one
 *     screener.delivery telemetry point to the existing Analytics
 *     Engine sink (best-effort; console-degraded when the binding
 *     is absent), so a lost delivery still leaves an outcome record
 *     — but telemetry is not redelivery, and it never re-sends a
 *     Slack/email/webhook notice.
 * Full statement: docs/architecture/security/screener-event-bus-loss-window-1770.md.
 */

export interface ScreenerOpportunity {
  symbol: string;
  companyName: string;
  signal: string;
  momentumScore: number;
  lastPrice: number;
  changePercent: number;
}

export interface ScreenerCompletedEvent {
  type: "screener.completed";
  timestamp: string;
  /** The selected stock universe; distinct from the sector filter. */
  universe?: string;
  trigger?: "manual" | "scheduled";
  /** Target size before any E*TRADE quote failures or filters. */
  expectedCount?: number;
  /** Per-run PDF storage key, avoiding races through the latest-report pointer. */
  pdfKey?: string;
  /** Issue #822: explicit PDF status. If 'failed', the publisher must NOT
   *  fall back to a stale PDF — log the error and skip the attachment. */
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  /** Issue #1191 (#1173 R3): per-run XLSX artifact, mirroring the PDF
   *  triple — outcomes carry it so deliveries attach text+PDF+XLSX. */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  /** Issue #1346: per-run CSV artifact, mirroring the PDF/XLSX
   *  triple. */
  csvKey?: string;
  csvStatus?: "generated" | "failed" | "skipped";
  csvError?: string;
  /** Stable delivery id used to suppress duplicate scheduled notifications. */
  deliveryId?: string;
  sector: string;
  totalScanned: number;
  matchedCount: number;
  opportunities: ScreenerOpportunity[];
  /**
   * Issue #462: qualification for a screen run on an incomplete quote set.
   * The delivered result is a qualified partial report — never presented as
   * a complete screen and never as a failure. Failed symbols carry no
   * fallback data.
   */
  partial?: {
    quotedCount: number;
    requestedCount: number;
    failedSymbols: string[];
    failureReasons: Record<string, number>;
  };
  /**
   * Issue #728: per-symbol rejection reasons. The Slack publisher groups
   * these into a breakdown (e.g. "42 downtrend, 31 negative-EV") so a
   * 0-match screen explains itself instead of just reporting the count.
   */
  rejections?: { symbol: string; reason: string }[];
  /** Summary of criteria applied during screening. */
  filterSummary?: string;
  /**
   * Issue #1527: whole-run fallback marker — the run fell back to
   * its provider because the configured provider's auth was dead.
   * Carried so deliveries and report bodies name the fallback.
   */
  providerFallback?: { from: string; reason: string };
  /** Direct recipient email (enables email dispatch via cfpay A2A or local fallback). */
  emailTo?: string;
  /** Explicit Slack channel destination. */
  slackChannel?: string;
  /** Outbound webhook endpoint. */
  webhookUrl?: string;
  /** Consolidation C3 (#1277): the schedule record's stage-chain
   *  config, carried so the follow-up bridge can stamp the run's
   *  stage jobs. Absent = the fused immediate chain. */
  stageChain?: import("../types").StageChainConfig;
  /**
   * Issue #3313: the originating schedule / workflow run, when the
   * producer knows it — carried onto the outcome so the bridge
   * record, the follow-up payloads, and the ledger row all join to
   * the same schedule/workflow. Absent = no originating schedule
   * (the bridge stamps an explicit null).
   */
  scheduleId?: string;
  workflowId?: string;
}

export interface ScreenerFailedEvent {
  type: "screener.failed";
  timestamp: string;
  universe?: string;
  trigger?: "manual" | "scheduled";
  deliveryId?: string;
  sector: string;
  error: string;
  emailTo?: string;
  slackChannel?: string;
  webhookUrl?: string;
  /** Consolidation C3 (#1277): stage-chain config, as on the
   *  completed event. */
  stageChain?: import("../types").StageChainConfig;
  /** Issue #3313: the originating schedule / workflow run, when the
   *  producer knows it (see the completed event). */
  scheduleId?: string;
  workflowId?: string;
}

/** One options opportunity as carried on the bus: a summary, not the full row. */
export interface OptionsOpportunitySummary {
  symbol: string;
  strategy?: string;
  directionTags?: string[];
}

/**
 * Issue #223: the options counterpart of screener.completed. Delivery for
 * options runs stays on the service's direct A2A path (PDF-centric); this
 * event puts the run's lifecycle on the bus so subscribers — digests
 * (#218), audit consumers, future publishers — see options runs exactly
 * like stock screens.
 */
export interface OptionsCompletedEvent {
  type: "options.completed";
  timestamp: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  thesis: string;
  totalScanned: number;
  withTrades: number;
  symbols: string[];
  summary: string;
  reportUrl?: string;
  opportunities: OptionsOpportunitySummary[];
  /**
   * Issue #1718: the run's partial qualification, when the scan could
   * not judge its whole requested universe — carried so outcome
   * consumers (lifecycle notifications) can apply the broadcast
   * coverage floor. Absent on complete runs.
   */
  partial?: import("../trading").OptionsPartialQualification;
  /** Consolidation C4 (#1329): the run's PDF key, so a chained
   *  options run's serve stage adopts the same artifact the direct
   *  path delivered. Absent on runs that produced no PDF. */
  pdfKey?: string;
  pdfStatus?: "generated" | "failed" | "skipped";
  pdfError?: string;
  /** Options run-record fix: the run's workbook + CSV, mirroring the stock event.
   *  Without them the bridged job outcome (and therefore the Workflow
   *  Runs artifact list) could name only the PDF a run produced. */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  csvKey?: string;
  csvStatus?: "generated" | "failed" | "skipped";
  csvError?: string;
  /** Consolidation C4 (#1329): stage-chain config when the schedule
   *  opted in — the bridge chains (serve/deliver) instead of
   *  recording only. Absent = the direct path (the degenerate case). */
  stageChain?: import("../types").StageChainConfig;
  /** Issue #3313: the originating schedule / workflow run, when the
   *  producer knows it (see the stock completed event). */
  scheduleId?: string;
  workflowId?: string;
}

export interface OptionsFailedEvent {
  type: "options.failed";
  timestamp: string;
  trigger?: "manual" | "scheduled";
  universe?: string;
  thesis: string;
  error: string;
  /** Consolidation C4 (#1329): as on the completed event — a chained
   *  failed run still records its generate stage + stop point. */
  stageChain?: import("../types").StageChainConfig;
  /** Issue #3313: the originating schedule / workflow run, when the
   *  producer knows it (see the stock completed event). */
  scheduleId?: string;
  workflowId?: string;
}

export type ScreenerEvent =
  | ScreenerCompletedEvent
  | ScreenerFailedEvent
  | OptionsCompletedEvent
  | OptionsFailedEvent;
export type ScreenerEventType = ScreenerEvent["type"];

export type ScreenerEventHandler = (event: ScreenerEvent) => Promise<void> | void;

/**
 * Minimal typed pub/sub bus. Handlers run sequentially in registration
 * order; each handler's errors are caught and logged so one failing
 * subscriber never breaks the others.
 */
export class ScreenerEventBus {
  private handlers = new Map<ScreenerEventType, ScreenerEventHandler[]>();

  /**
   * Subscribe to an event type. Returns an unsubscribe function.
   */
  subscribe(type: ScreenerEventType, handler: ScreenerEventHandler): () => void {
    const list = this.handlers.get(type) ?? [];
    list.push(handler);
    this.handlers.set(type, list);
    return () => {
      const current = this.handlers.get(type) ?? [];
      this.handlers.set(
        type,
        current.filter((h) => h !== handler)
      );
    };
  }

  /**
   * Publish an event to all subscribers. Never throws.
   */
  async publish(event: ScreenerEvent): Promise<void> {
    const list = this.handlers.get(event.type) ?? [];
    for (const handler of list) {
      try {
        await handler(event);
      } catch (err) {
        console.warn(
          `[ScreenerEventBus] subscriber failed for ${event.type}:`,
          err instanceof Error ? err.message : String(err)
        );
      }
    }
  }

  /** Number of subscribers for a type (useful for tests/health). */
  subscriberCount(type: ScreenerEventType): number {
    return this.handlers.get(type)?.length ?? 0;
  }
}
