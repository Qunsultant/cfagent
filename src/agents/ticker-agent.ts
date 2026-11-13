/**
 * Issue #2230 — market quotes ticker as a PortThink agent.
 *
 * The ticker WebSocket (`/api/market/quotes/ws`, plus the
 * `/api/market-data/` and `/api/foss/` aliases) was a hand-rolled raw
 * WebSocket in the Worker: `server.ts` created a `WebSocketPair` and
 * handed the server side to `handleMarketQuotesWebSocket`. That handler
 * is retained (its pin tests in `market_stream.test.ts`,
 * `marketstream_baseline_929.test.ts`, and `quote_modes_1725.test.ts`
 * pin the wire protocol), but production traffic now goes through
 * this agent instead.
 *
 * Architecture (no deviation from the ports/adapter architecture):
 * `TickerAgent extends PortThink`, the same base as
 * `OrchestratorAgent` (`PortThink extends Think extends Agent`).
 * PortThink's turn facet is inert here — `portHooks` is never set and
 * no turn ever runs — so the agent uses only the Agent WebSocket
 * surface: `onConnect` / `onMessage` / `onClose`,
 * `getConnections`, and the SDK scheduler. Think's `onStart` (chat
 * session bootstrap) is deliberately NOT invoked: the ticker runs no
 * turns, and `onStart` here only reconciles the tick schedule (see
 * below).
 *
 * Protocol parity with the old handler (both clients — app
 * `quotesService.ts` and landing `landing.ts` — are unchanged):
 * - `subscribe` → `snapshot` frame (`quotes` + `unavailable`).
 * - `unsubscribe` → symbols dropped from that connection's set.
 * - `ping` → `pong` frame. Malformed frames → `error` frame.
 * - `ticks` frames every 5s per connection, filtered to that
 *   connection's symbols, cached-first then refreshed — the same
 *   send-cached / refresh / send-again shape as the old handler.
 * - Header carriers: `x-quote-expiry-mode` /
 *   `x-quote-stream-provenance` are read from the upgrade request in
 *   `onConnect` and stored per connection, exactly as the old Worker
 *   branch passed them as options.
 *
 * Auth surface preserved: the ticker endpoint has no auth and no
 * audit (M10). It is therefore NOT routed through `routeAgentRequest`
 * `onBeforeConnect` (which 401s unauthenticated callers — that would
 * break the public landing page tape). `server.ts` addresses the
 * single shared instance directly (`idFromName("ticker")`) and
 * forwards the upgrade request to the stub; the SDK's stub fetch
 * performs the upgrade and drives `onConnect`.
 *
 * Single shared instance: the current surface is global, so
 * per-user instances would fragment the quote-cache refresh for no
 * benefit. Subscriptions live in per-connection state, which the SDK
 * re-establishes across hibernation. The tick schedule follows
 * listener presence (issue #2443), never wall-clock time: it is armed
 * on first connect, cancelled on last disconnect, and reconciled on
 * every start — armed when listeners are present (a restart that
 * restores connections re-arms), cancelled when none are (which also
 * retires schedules a pre-fix build armed). `scheduleEvery` is
 * idempotent, so re-arming never creates duplicates, and a tick that
 * fires with zero connections cancels the schedule instead of
 * spinning the alarm forever. Work happens only when observed.
 *
 * Protocol messages are disabled (`shouldSendProtocolMessages` →
 * false): ticker clients are plain WebSockets, not `useAgent`
 * clients, and must see only snapshot/ticks/pong/error frames.
 */
import type { Connection, ConnectionContext, WSMessage } from "agents";
import {
  levelsForQuoteSwitch,
  resolveQuoteExpiryMode,
  resolveQuoteStreamProvenance,
  type QuoteExpiryMode,
  type QuoteStreamProvenance,
} from "../config/quoteModes";
import {
  annotateStreamTicks,
  getBatchMarketQuotes,
  refreshQuotesInBackground,
  type MarketStreamClientMessage,
} from "../services/marketStream";
import type { Env } from "../types";
import { PortThink } from "../actors/thinkAdapter";
import { createUnifiedSchedulePorts } from "../data/createUnifiedSchedulePorts";
import type {
  SyncScheduleStore,
  UnifiedScheduleRecord,
} from "../data/unifiedSchedulePorts";
import {
  TICKER_PUSH_RECORD_ID,
  tickerPushScheduleToRecord,
} from "../services/unifiedScheduleManagement";
import { createResourceUsagePort } from "../telemetry/createResourceUsagePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/ticker-agent",
});

/** Per-connection ticker state, restored by the SDK across hibernation. */
export interface TickerConnectionState {
  symbols: string[];
  expiryMode: QuoteExpiryMode;
  streamProvenance: QuoteStreamProvenance;
}

/** Tick push cadence default, in seconds (issue #2443). Owner-visible override: the TICKER_PUSH_INTERVAL_S wrangler var (seconds); an interval CHANGE is a product call and is out of #2443. */
export const TICKER_PUSH_INTERVAL_SECONDS = 5;

/**
 * Issue #4352 — the floor for an operator-set cadence. A tick faster than
 * this would push quotes faster than the deployment's own default poll and
 * multiply the broker calls a connected UI makes; the refusal names the floor.
 */
export const TICKER_PUSH_MIN_INTERVAL_SECONDS = 5;

/**
 * Stale threshold default, in missed intervals (issue #4237):
 * the Schedules home shows a missed push once the last push is
 * older than this many push cadences. Owner-visible override: the
 * TICKER_PUSH_STALE_AFTER_INTERVALS wrangler var; a threshold
 * CHANGE is a product call, like the interval.
 */
export const TICKER_PUSH_STALE_AFTER_INTERVALS = 2;

/** Callback name of the tick schedule; must match the pushTicks method name. */
export const TICKER_PUSH_CALLBACK = "pushTicks";

/**
 * Resolve the missed-push threshold from env (issue #4237, AOP):
 * the TICKER_PUSH_STALE_AFTER_INTERVALS var wins when it parses
 * to a positive integer; anything else (absent, non-numeric, zero,
 * negative) falls back to the default. The health derivation never
 * carries a literal.
 */
export function resolveTickerPushStaleAfterIntervals(env: Env | undefined): number {
  const raw = env?.TICKER_PUSH_STALE_AFTER_INTERVALS;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TICKER_PUSH_STALE_AFTER_INTERVALS;
}

/**
 * Resolve the tick push cadence from env (issue #2443, AOP): the
 * TICKER_PUSH_INTERVAL_S var wins when it parses to a positive
 * integer; anything else (absent, non-numeric, zero, negative) falls
 * back to the default. The arm call sites never carry a literal.
 */
export function resolveTickerPushIntervalSeconds(env: Env | undefined): number {
  const raw = env?.TICKER_PUSH_INTERVAL_S;
  if (raw !== undefined) {
    const parsed = Number.parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return TICKER_PUSH_INTERVAL_SECONDS;
}

/** Name of the single shared ticker instance. */
export const TICKER_INSTANCE_NAME = "ticker";

export class TickerAgent extends PortThink {
  /**
   * Surface a ticker-schedule failure (issue #2443: never silently
   * swallowed): a Workers-Logs line always, plus a best-effort event
   * on the existing resourceSink attribution. Never throws — the
   * lifecycle callers that report here must not break on a
   * bookkeeping failure, and the next lifecycle event reconciles.
   */
  private reportTickerScheduleFailure(op: string, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    structuredLog.error("tickerAgent.ticker_schedule_failed", {
      message: `[TickerAgent] ticker schedule ${op} failed: ${message}`,
      op,
      error: message,
    });
    try {
      const sink = createResourceUsagePort(this.env as Env);
      if (sink) {
        void sink.record({
          ns: "ticker",
          op: `schedule-${op}`,
          rowsRead: 0,
          rowsWritten: 0,
          caller: "TickerAgent",
          trigger: "scheduled",
          timestampMs: Date.now(),
        });
      }
    } catch {
      // Attribution is best-effort: the log line above is the surface.
    }
  }

  /** Connections as an array, or null when enumeration itself fails. */
  private listTickerConnections(): Connection<TickerConnectionState>[] | null {
    try {
      return [...this.getConnections<TickerConnectionState>()];
    } catch (err) {
      this.reportTickerScheduleFailure("list-connections", err);
      return null;
    }
  }

  /** The interval an existing record carries, or null when it has none. */
  private recordedIntervalSeconds(
    existing: UnifiedScheduleRecord | null,
  ): number | null {
    if (!existing) return null;
    const value = (existing.definition as Record<string, unknown> | undefined)
      ?.intervalSeconds;
    return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
  }

  /** Whether the operator paused the feed (issue #4352). */
  private recordedPaused(existing: UnifiedScheduleRecord | null): boolean {
    if (!existing) return false;
    return (existing.definition as Record<string, unknown> | undefined)?.paused === true;
  }

  /**
   * Issue #4352 — the feed is schedulable like any other job: the operator
   * pauses it (the pause survives every start and every connection), resumes
   * it, and sets its cadence. The three RPC methods below are the only write
   * surface; each records the fact on the one ticker-push record.
   */
  async pauseTickerPush(): Promise<{ ok: true }> {
    await this.cancelTickerPush();
    await this.recordTickerPush({ armed: false, paused: true });
    return { ok: true };
  }

  async resumeTickerPush(): Promise<{ ok: true }> {
    await this.recordTickerPush({ armed: false, paused: false });
    await this.ensureTickerPushArmed();
    return { ok: true };
  }

  async setTickerPushInterval(
    intervalSeconds: number,
  ): Promise<{ ok: true; intervalSeconds: number }> {
    const value = Number(intervalSeconds);
    if (!Number.isFinite(value) || value < TICKER_PUSH_MIN_INTERVAL_SECONDS) {
      throw new Error(
        `The ticker push interval must be at least ${TICKER_PUSH_MIN_INTERVAL_SECONDS} seconds.`,
      );
    }
    const rounded = Math.round(value);
    // Re-arm at the new cadence (the SDK arms one schedule per callback).
    await this.cancelTickerPush();
    await this.recordTickerPush({ armed: false, intervalSeconds: rounded });
    await this.ensureTickerPushArmed();
    return { ok: true, intervalSeconds: rounded };
  }

  /** Arm the tick schedule (idempotent per the SDK). Surfaces failures, never throws. */
  private async ensureTickerPushArmed(): Promise<void> {
    try {
      // Issue #4352 — a paused feed is never armed, and a recorded cadence
      // outranks the deployment default.
      const existing = this.tickerScheduleStore()?.get(TICKER_PUSH_RECORD_ID) ?? null;
      if (this.recordedPaused(existing)) {
        await this.recordTickerPush({ armed: false, paused: true });
        return;
      }
      const intervalSeconds =
        this.recordedIntervalSeconds(existing) ??
        resolveTickerPushIntervalSeconds(this.env as Env | undefined);
      const schedule = await this.scheduleEvery(
        intervalSeconds,
        TICKER_PUSH_CALLBACK,
      );
      // Issue #4237 — the armed feed adopts its one schedule record.
      await this.recordTickerPush({
        armed: true,
        alarmId:
          schedule && typeof (schedule as { id?: unknown }).id === "string"
            ? (schedule as { id: string }).id
            : null,
      });
    } catch (err) {
      this.reportTickerScheduleFailure("arm", err);
    }
  }

  /**
   * The ticker's own unified-store instance (ADR 0029 D-0 — the
   * record lives in the same DO as the mechanism), or null when this
   * host has no DO SQLite (test doubles, non-SQL hosts). Never throws.
   */
  private tickerScheduleStore(): SyncScheduleStore | null {
    try {
      const storage = (
        this as unknown as { ctx?: { storage?: { sql?: unknown } } }
      ).ctx?.storage;
      const sql = storage?.sql;
      if (!sql) return null;
      return createUnifiedSchedulePorts({ sql: sql as never })
        .unifiedSchedulesSync;
    } catch {
      return null;
    }
  }

  /**
   * Upsert the ticker-push record (issue #4237): the one record for
   * the live feed, updated in place on arm / push / idle-cancel.
   * Best-effort — a store failure is reported, never thrown, so
   * recording can never break the feed.
   */
  private async recordTickerPush(patch: {
    armed: boolean;
    alarmId?: string | null;
    lastPushAt?: string;
    /** Issue #4352 — the operator's pause; survive every later write. */
    paused?: boolean;
    intervalSeconds?: number;
  }): Promise<void> {
    try {
      const store = this.tickerScheduleStore();
      if (!store) return;
      const nowIso = new Date().toISOString();
      const existing = store.get(TICKER_PUSH_RECORD_ID);
      store.save(
        tickerPushScheduleToRecord(
          {
            intervalSeconds:
              patch.intervalSeconds ??
              this.recordedIntervalSeconds(existing ?? null) ??
              resolveTickerPushIntervalSeconds(this.env as Env | undefined),
            armed: patch.armed,
            ...(patch.paused !== undefined ? { paused: patch.paused } : {}),
            ...(patch.alarmId !== undefined ? { alarmId: patch.alarmId } : {}),
            ...(patch.lastPushAt !== undefined
              ? { lastPushAt: patch.lastPushAt }
              : {}),
          },
          nowIso,
          existing ?? null,
        ),
      );
    } catch (err) {
      this.reportTickerScheduleFailure("record", err);
    }
  }

  /**
   * The ticker-push record for the Schedules home list route's RPC
   * read (issue #4237). Null when the feed was never armed or this
   * host has no store — never throws, so the list degrades to
   * omitting the row.
   */
  async getTickerPushRecord(): Promise<UnifiedScheduleRecord | null> {
    try {
      const store = this.tickerScheduleStore();
      if (!store) return null;
      return store.get(TICKER_PUSH_RECORD_ID) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * Cancel every pushTicks schedule. Surfaces failures, never throws.
   * A schedule that is already gone (cancel returns false) is not a
   * failure — idle-cancel is idempotent by design.
   */
  private async cancelTickerPush(): Promise<void> {
    let schedules: Array<{ id: string; callback: string }>;
    try {
      schedules = await this.listSchedules();
    } catch (err) {
      this.reportTickerScheduleFailure("list", err);
      return;
    }
    for (const schedule of schedules) {
      if (schedule.callback !== TICKER_PUSH_CALLBACK) continue;
      try {
        await this.cancelSchedule(schedule.id);
      } catch (err) {
        this.reportTickerScheduleFailure("cancel", err);
      }
    }
    // Issue #4237 — the feed is off (no listeners): the record stays,
    // disarmed, so the home shows Idle rather than a missed push.
    await this.recordTickerPush({ armed: false });
  }

  override async onStart(): Promise<void> {
    // Issue #2443 — reconcile, never arm unconditionally. With
    // listeners present (a restart that restores connections) re-arm;
    // with none, cancel — which also retires schedules a pre-fix
    // build armed. Enumeration failure fails safe toward ticks: arm.
    const connections = this.listTickerConnections();
    if (connections === null || connections.length > 0) {
      await this.ensureTickerPushArmed();
    } else {
      await this.cancelTickerPush();
    }
  }

  override shouldSendProtocolMessages(): boolean {
    return false;
  }

  override async onConnect(
    connection: Connection<TickerConnectionState>,
    ctx: ConnectionContext,
  ): Promise<void> {
    const env = this.env as Env | undefined;
    connection.setState({
      symbols: [],
      expiryMode: resolveQuoteExpiryMode(
        levelsForQuoteSwitch(
          undefined,
          ctx.request.headers.get("x-quote-expiry-mode") ?? undefined,
          env?.QUOTE_EXPIRY_MODE,
        ),
        "continuity",
      ).mode,
      streamProvenance: resolveQuoteStreamProvenance(
        levelsForQuoteSwitch(
          undefined,
          ctx.request.headers.get("x-quote-stream-provenance") ?? undefined,
          env?.QUOTE_STREAM_PROVENANCE,
        ),
        "bare",
      ).mode,
    });
    // Issue #2443 — lazy-arm: the first listener starts the ticks.
    await this.ensureTickerPushArmed();
  }

  override async onClose(
    connection: Connection<TickerConnectionState>,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    // Issue #2443 — idle-cancel. The SDK invokes onClose BEFORE
    // removing the closing connection, so it is still counted here:
    // exclude it by id. Enumeration failure skips the cancel (the
    // last listener cannot be proven) — the next wake or tick
    // reconciles instead of cancelling on a guess.
    const connections = this.listTickerConnections();
    if (connections === null) return;
    const remaining = connections.filter((c) => c.id !== connection.id);
    if (remaining.length === 0) {
      await this.cancelTickerPush();
    }
  }

  override async onMessage(
    connection: Connection<TickerConnectionState>,
    message: WSMessage,
  ): Promise<void> {
    if (typeof message !== "string") return;
    try {
      const msg = JSON.parse(message) as MarketStreamClientMessage;
      const state = connection.state;
      if (!state) return;
      if (msg.type === "subscribe" && Array.isArray(msg.symbols)) {
        const quotes: ReturnType<typeof getBatchMarketQuotes> = [];
        const unavailable: string[] = [];
        const symbols = [...state.symbols];
        for (const sym of msg.symbols) {
          const upper = sym.toUpperCase().trim();
          if (!upper) continue;
          if (!symbols.includes(upper)) symbols.push(upper);
          const found = getBatchMarketQuotes([upper], state.expiryMode)[0];
          if (found) quotes.push(found);
          else unavailable.push(upper);
        }
        // Connection state is immutable: replace, never mutate.
        connection.setState({ ...state, symbols });
        connection.send(
          JSON.stringify({
            type: "snapshot",
            quotes: annotateStreamTicks(quotes, state.streamProvenance),
            unavailable,
          }),
        );
      } else if (msg.type === "unsubscribe" && Array.isArray(msg.symbols)) {
        const dropped = new Set(msg.symbols.map((s) => s.toUpperCase().trim()));
        // Connection state is immutable: replace, never mutate.
        connection.setState({
          ...state,
          symbols: state.symbols.filter((s) => !dropped.has(s)),
        });
      } else if (msg.type === "ping") {
        connection.send(JSON.stringify({ type: "pong", timestamp: Date.now() }));
      }
    } catch (err: unknown) {
      connection.send(
        JSON.stringify({
          type: "error",
          message: err instanceof Error ? err.message : "Invalid market stream message",
        }),
      );
    }
  }

  /** Scheduled tick push: one filtered frame per subscribed connection. */
  async pushTicks(): Promise<void> {
    const env = this.env as Env | undefined;
    const connections = this.listTickerConnections();
    if (connections !== null && connections.length === 0) {
      // Issue #2443 — idle: no listener remains (e.g. a pre-fix
      // schedule outliving its connections on a warm instance).
      // Cancel instead of spinning the alarm forever. Connected but
      // unsubscribed clients do NOT trigger this: they may subscribe
      // later, and only a disconnect cancels.
      await this.cancelTickerPush();
      return;
    }
    for (const connection of connections ??
      this.getConnections<TickerConnectionState>()) {
      const state = connection.state;
      if (!state || state.symbols.length === 0) continue;
      // Copy out of the immutable connection state before passing on.
      const symbols = [...state.symbols];
      try {
        // Keep the stream responsive even when an upstream quote
        // provider is slow or unavailable: publish the latest cached
        // quote before waiting on I/O.
        connection.send(
          JSON.stringify({
            type: "ticks",
            ticks: annotateStreamTicks(
              getBatchMarketQuotes(symbols, state.expiryMode),
              state.streamProvenance,
            ),
          }),
        );
        await refreshQuotesInBackground(symbols, env);
        connection.send(
          JSON.stringify({
            type: "ticks",
            ticks: annotateStreamTicks(
              getBatchMarketQuotes(symbols, state.expiryMode),
              state.streamProvenance,
            ),
          }),
        );
      } catch {
        // A failed provider refresh leaves the last known quote visible.
      }
    }
    // Issue #4237 — the push completed: stamp the record so the
    // Schedules home sees the feed as live. A loop that throws
    // above reaches no stamp, and the home shows the miss.
    await this.recordTickerPush({
      armed: true,
      lastPushAt: new Date().toISOString(),
    });
  }
}
