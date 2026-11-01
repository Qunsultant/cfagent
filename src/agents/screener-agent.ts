/**
 * ScreenerAgent (issue #261) — the dedicated screening agent.
 *
 * Owns ALL stock screening: manual triggers and the scheduled tick run
 * through this agent, one backend, one frontend. Listing stocks adds no
 * value — the job is to SCREEN (filter to what matters).
 *
 * Market data is provider-scoped (issue #1007): the default provider
 * is E*TRADE; a run may instead name the Yahoo Finance data-source
 * adapter (provider "yahoo", the market-data surface). A provider changes
 * data provenance only — semantics, scoring, result shape and
 * persistence are identical. If the named provider is unavailable the
 * screen fails honestly (e.g. "E*TRADE unavailable" / "Yahoo Finance
 * unavailable") — no cross-provider fallback, no zero-filled
 * substitute rows.
 *
 * State is persisted via ctx.storage (Durable Object storage).
 */

import { PortThink } from "../actors/thinkAdapter";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  dispatchScreenerA2A,
  screenerA2AOutcome,
  type ScreenerA2AOutcome,
} from "./screenerA2aDispatch";
import { getServiceUserLogin } from "../security/serviceIdentity";
import { DatabaseORM } from "../orm";
import { ETradeService } from "../services/etrade";
import { createScreenRunLockPort } from "../data/createScreenRunLockPorts";
import type { ScreenRunLockPort } from "../data/screenRunLockPorts";
import { defaultBreakerRegistry } from "../breakers/createBreakerPorts";
import {
  applyPortfolioContextToOpportunities,
  type PortfolioContextMarker,
} from "../services/portfolioContextRanking";
import { DynamicMarketScreener } from "../trading";
import {
  acquireUniverse,
  screenUniverse,
  selectStandouts,
  buildAllStocks,
  attachFactorGrades,
  attachTechnicals,
  toOpportunityStock,
  type ScannedStock,
  type OpportunityStock,
  type PartialQuoteQualification,
} from "../trading";
import {
  UNIVERSES,
  shardableUniverses,
  resolveUniverse,
  type StockScreenProvider,
  type UniverseId,
} from "../trading";
import { YahooFinanceProvider } from "../services/marketDataResearch";
import {
  bindEtradeQuoteDeps,
  bindNasdaqUniverseDeps,
  bindYahooScreenerDeps,
  bootstrapDataProviders,
  createETradeDataProvider,
  createNasdaqDataProvider,
  createYahooDataProvider,
  DataProviderRegistry,
  etradeQuoteProviderFromRoute,
  fetchPlatformTechnicalsBatch,
  getProviderConfig,
  listCapabilityRoutes,
  listProviderConfigs,
  nasdaqUniverseProviderFromRoute,
  nasdaqUniverseRouteBundle,
  resolveYahooHistoryDeps,
  transitionProvider,
  transitionProviderViaPort,
  verifyNasdaqDataProvider,
  verifyYahooDataProvider,
  yahooQuoteProviderFromRoute,
  type CapabilityRouteRecord,
  type ProviderConfigRecord,
  type ProviderLifecycleAction,
  type ProviderTransitionDeps,
} from "../trading";
import type { SqlStorage } from "../orm";
import type { Env } from "../types";
import { buildDataProviderPorts } from "../data/buildDataProviderPorts";
import type { D1ProviderConfigAdapter } from "../data/d1ProviderConfigAdapter";
import type { D1ProviderCaptureAdapter } from "../data/d1ProviderCaptureAdapter";
import type {
  CaptureBlobStorage,
  ProviderCaptureStore,
} from "../data/providerCapturePorts";
import type { NasdaqStockListing } from "../services/nasdaqListings";
import {
  DEFAULT_STALE_AFTER_MS,
  ScreenerTaskLedger,
  evaluateScreenerOutcome,
  type ScreenerTask,
  type ScreenerTaskEvaluation,
  type ScreenerTaskStore,
} from "../services/screenerTaskLedger";
import { DEFAULT_SCREENER_CONFIG } from "../trading";
import type { StockScreenerFilter } from "../types";
import {
  DynamicOptionsScreener,
  type ScreeningProviderAssetClass,
} from "../trading";
import type { OptionScreenerFilter } from "../types";
import type { ScenarioDefinition } from "../services/goalScenarioEngine";
import type { GoalDrivenScreenResult } from "../services/goalDrivenScreen";

export interface ScreenerRunRequest {
  /** Who triggered the screen. */
  trigger: "manual" | "scheduled";
  /** Manual: user filters (search/limit/price-range/trend). Scheduled: { sector }. */
  filters?: StockScreenerFilter;
  /** Scheduled: sector label (issue #421: "ALL" when none was selected). */
  sector?: string;
  /** Universe to screen (default "TECH"). "ALL" auto-shards (see runSharded). */
  universe?: UniverseId;
  /** Scheduled: max standout opportunities (default 5). */
  maxItems?: number;
  /** Optional explicit symbol universe (overrides universe selector). */
  symbols?: NasdaqStockListing[];
  /** Cap on symbols quoted via E*TRADE (default: universe default). */
  maxSymbols?: number;
  /** User login for E*TRADE auth scoping. */
  userLogin?: string;
  /** E*TRADE environment selected by the signed-in user. */
  environment?: "TEST" | "PROD";
  /**
   * Issue #1007: data provider for this run (default "etrade"). The
   * Yahoo provider quotes through the platform yahoo provider
   * (#1317); it never touches E*TRADE and never falls back to it.
   */
  provider?: StockScreenProvider;
  /**
   * Issue #1527: explicit whole-run fallback marker — set by the
   * scheduled layer when it falls back to Yahoo because the
   * configured provider's auth is dead. Carried onto the result so
   * every provenance surface (PDF, event, outcome) can name the run
   * as a fallback, never as the configured provider's live run.
   */
  providerFallback?: {
    from: StockScreenProvider;
    reason: string;
  };
  /**
   * Issue #1007: test seam — an injected Yahoo quote fetcher for
   * provider "yahoo" runs (mirrors the pipeline's yahooDeps). Absent
   * in production, where the platform yahoo provider is bound here.
   */
  yahooDeps?: import("../trading").YahooScreenerDeps;
  /**
   * Issue #17 (opt-in, default off — the orchestrator/scheduler set
   * this from the screening.portfolioContext flag): demote
   * concentration-flagged opportunities below unflagged ones. A
   * modifier only — it never filters, never rescores, and a run that
   * cannot load a connected book runs unmodified with a marker
   * reason instead of failing.
   */
  portfolioContext?: boolean;
}

export interface ScreenerRunResult {
  timestamp: string;
  trigger: "manual" | "scheduled";
  /** Issue #1007: the data provider that produced this run. */
  provider: StockScreenProvider;
  /**
   * Issue #1527: whole-run fallback marker, carried from the request
   * when the run fell back to its provider (see the request field).
   */
  providerFallback?: {
    from: StockScreenProvider;
    reason: string;
  };
  /** Universe screened (issue #270). */
  universe: UniverseId;
  sector: string;
  success: boolean;
  totalScanned: number;
  /** Symbols selected for this run before E*TRADE quote failures. */
  expectedCount?: number;
  matchedCount: number;
  /** Standout opportunities (the screening result — what matters). */
  opportunities: OpportunityStock[];
  /** Full scanned set with provenance (for the results table). */
  allStocks: ScannedStock[];
  discoveryMessage: string;
  /** Summary of criteria applied during screening. */
  filterSummary?: string;
  /**
   * Issue #462: set when the screen ran on an incomplete quote set. The
   * result is a qualified partial report — never a complete screen, never
   * a failure. Zero quotes still fails honestly (success:false + error).
   */
  partial?: PartialQuoteQualification;
  /** Issue #728: per-symbol rejection reasons for the Slack breakdown. */
  rejections?: { symbol: string; reason: string }[];
  /**
   * Issue #17: portfolio-context marker — present whenever the caller
   * asked for the modifier (portfolioContext: true). `applied` means
   * the modifier ran against a connected book; otherwise `reason`
   * names why the ranking is unmodified. Consumers (PDF, event,
   * outcome) must surface this whenever they surface opportunities,
   * so a modified ranking is never presented as raw.
   */
  portfolioContext?: PortfolioContextMarker;
  /**
   * Issue #1184 (#1173 R2): technicals coverage for this run — how
   * many quoted symbols the Yahoo history leg actually produced
   * MACD / gap values for. Recorded so a technicals outage is data
   * (the 2026-10-23 run showed blank MACD/Gap on every row with no
   * signal anywhere that history coverage was zero).
   */
  technicalsCoverage?: { symbols: number; withMacd: number; withGap: number };
  /** Per-run PDF key populated by persistRun after the PDF is stored. */
  pdfKey?: string;
  /** Issue #822: explicit PDF generation status. 'failed' means generatePdfAsset
   *  threw or returned null — the publisher must NOT fall back to a stale PDF. */
  pdfStatus?: "generated" | "failed" | "skipped";
  /** When pdfStatus is 'failed', the error that caused it. */
  pdfError?: string;
  /** Per-run XLSX key populated by persistRun after the XLSX report is stored. */
  xlsxKey?: string;
  xlsxStatus?: "generated" | "failed" | "skipped";
  xlsxError?: string;
  /** Issue #1346: per-run CSV key, populated by persistRun after
   *  the CSV report is stored (same failure contract as XLSX). */
  csvKey?: string;
  csvStatus?: "generated" | "failed" | "skipped";
  csvError?: string;
  /** Issue #816: quote pipeline trace summary for the UI. */
  quoteTrace?: {
    traceId: string;
    symbolCount: number;
    batchCount: number;
    quotesReceived: number;
    quotesFailed: number;
    failuresByCategory: Record<string, number>;
    batches: Array<{
      batchIndex: number;
      symbolCount: number;
      httpStatus: number | null;
      quotesReceived: number;
      failures: Array<{ symbol: string; category: string; detail: string }>;
      durationMs: number;
    }>;
  };
  error?: string;
  /** Duplicate scheduled delivery was suppressed by the shared per-user DO. */
  skippedDuplicate?: boolean;
  /** Issue #607: durable task record id for this run (screener task ledger). */
  taskId?: string;
  /** Issue #1157 (E2): the data-provider platform run id for
   *  E*TRADE-provider runs — minted at run start, carried in every
   *  capture the run's quote fetches write, and stamped here so the
   *  result and its captures share one identity. Absent for
   *  non-E*TRADE providers (their platform cutover is a later slice). */
  runId?: string;
  /** Issue #706: learnings applied at run start. */
  appliedLearnings?: string[];
}

const LATEST_KEY = "screener:latest";
/** Issue #624: minimum interval between task heartbeat writes during a run. */
const SCREENER_HEARTBEAT_MIN_MS = 60_000;
const HISTORY_KEY = "screener:history";
// Issue #297: Per-run PDF storage (not a single shared key).
// Each run gets its own key to prevent franken-PDFs.
const PDF_KEY_PREFIX = "screener:pdf:";
const PDF_LATEST_KEY = "screener:latest.pdf";
// XLSX report storage
const XLSX_KEY_PREFIX = "screener:xlsx:";
const XLSX_LATEST_KEY = "screener:latest.xlsx";
const CSV_LATEST_KEY = "screener:latest.csv";
// Issue #361: Options PDF storage (mirrors stock pattern). Since #1023
// (single PDF path) per-run options PDFs are generated + stored by
// ReportAssetAgent and addressed by its key; this constant remains only
// as the read key for getLatestOptionsPdf's legacy local lookup.
const OPTIONS_PDF_LATEST_KEY = "options:latest.pdf";
/** Issue #1195 (#1173 R3b): options XLSX storage keys. */
const OPTIONS_XLSX_KEY_PREFIX = "options:xlsx:";
const OPTIONS_XLSX_LATEST_KEY = "options:latest.xlsx";
const OPTIONS_CSV_LATEST_KEY = "options:latest.csv";

export class ScreenerAgent extends PortThink {
  private orm: DatabaseORM | null = null;

  /**
   * #2303 (#1976 step 1): the data-provider platform ports,
   * built lazily from env (AGENT_DB) and schema-ensured once
   * per instance. The platform* helpers below run each platform
   * store interaction through the ports when they are bound
   * (production) and through the legacy DO store otherwise —
   * reads and writes always use the SAME side within a block,
   * so route resolution never reads a store the bootstrap did
   * not write.
   */
  private dataProviderPortsPromise?: Promise<{
    config: D1ProviderConfigAdapter | null;
    captures: D1ProviderCaptureAdapter | null;
  }>;

  private dataProviderPorts(): Promise<{
    config: D1ProviderConfigAdapter | null;
    captures: D1ProviderCaptureAdapter | null;
  }> {
    if (!this.dataProviderPortsPromise) {
      this.dataProviderPortsPromise = buildDataProviderPorts(this.env);
    }
    return this.dataProviderPortsPromise;
  }

  private async platformBootstrap(): Promise<void> {
    const { config } = await this.dataProviderPorts();
    if (config) await config.bootstrapDataProviders();
    else bootstrapDataProviders(this.ctx.storage.sql);
  }

  private async platformConfig(
    id: "etrade" | "public" | "yahoo" | "nasdaq" | "alpaca"
  ): Promise<ProviderConfigRecord | null> {
    const { config } = await this.dataProviderPorts();
    return config
      ? config.getProviderConfig(id)
      : getProviderConfig(this.ctx.storage.sql, id);
  }

  private async platformConfigs(): Promise<ProviderConfigRecord[]> {
    const { config } = await this.dataProviderPorts();
    return config
      ? config.listProviderConfigs()
      : listProviderConfigs(this.ctx.storage.sql);
  }

  private async platformRoutes(): Promise<CapabilityRouteRecord[]> {
    const { config } = await this.dataProviderPorts();
    return config
      ? config.listCapabilityRoutes()
      : listCapabilityRoutes(this.ctx.storage.sql);
  }

  private async platformTransition(
    id: string,
    action: ProviderLifecycleAction,
    actor: string,
    deps: ProviderTransitionDeps
  ): Promise<ProviderConfigRecord> {
    const { config } = await this.dataProviderPorts();
    return config
      ? transitionProviderViaPort(config, id, action, actor, deps)
      : transitionProvider(this.ctx.storage.sql, id, action, actor, deps);
  }

  private async platformCaptureDeps(): Promise<{
    sql: SqlStorage;
    blobStorage: CaptureBlobStorage;
    env: Env;
    capturePort?: ProviderCaptureStore;
  }> {
    const { captures } = await this.dataProviderPorts();
    return {
      sql: this.ctx.storage.sql,
      blobStorage: this.ctx.storage,
      env: this.env,
      ...(captures ? { capturePort: captures } : {}),
    };
  }

  private getOrm(): DatabaseORM {
    if (!this.orm) {
      // Issue #2361 (#1976 step 4e): the standard composition —
      // DatabaseORM over the instance's own storage handle, the
      // construction every other host uses. The hand-rolled exec
      // facade that stood here (a wrapper whose only effect was
      // spreading the cursor into an array, which the ORM's
      // Array.from reads already do) is retired.
      this.orm = new DatabaseORM(this.ctx.storage.sql);
    }
    return this.orm;
  }

  async claimScheduledExecution(jobKey: string, environment?: string): Promise<boolean> {
    const slot = new Date().toISOString().slice(0, 16);
    const key = `screening:scheduled:last-slot:${environment || "PROD"}:${jobKey}`;
    const storage = this.ctx.storage as any;
    if (typeof storage.transaction === "function") {
      return storage.transaction(async (txn: any) => {
        const current = await txn.get(key) as { slot: string } | undefined;
        if (current?.slot === slot) return false;
        await txn.put(key, { environment, jobKey, slot });
        return true;
      });
    }
    const current = await storage.get(key) as { slot?: string } | undefined;
    if (current?.slot === slot) return false;
    await storage.put(key, { environment, jobKey, slot });
    return true;
  }

  private static OWNER_STORAGE_KEY = "screener:owner-login";

  /**
   * Issue #1185: record this instance's owner at entry — the login the
   * orchestrator threaded from the validated session header (or the
   * schedule's stored owner) when dispatching work to this instance.
   */
  private async recordOwner(userLogin: string): Promise<void> {
    if (userLogin) {
      await this.ctx.storage.put(ScreenerAgent.OWNER_STORAGE_KEY, userLogin);
    }
  }

  /**
   * Issue #1185: this instance's owner login — the owner recorded at
   * entry; before any entry, the instance name itself encodes it
   * (`screener:<login>`; the bare shared instance belongs to the
   * configured service identity). Fail closed when none exists: there
   * is no synthetic shared identity to attribute runs or reports to.
   */
  private async userLogin(): Promise<string> {
    const recorded = await this.ctx.storage.get<string>(ScreenerAgent.OWNER_STORAGE_KEY);
    if (recorded) return recorded;
    const name = this.name ?? "";
    if (name.startsWith("screener:")) return name.slice("screener:".length);
    if (name === "default") {
      const serviceLogin = getServiceUserLogin(this.env);
      if (serviceLogin) return serviceLogin;
    }
    throw new Error("ScreenerAgent has no owner identity recorded for this instance (issue #1185: no default identity).");
  }

  /**
   * Issue #607: task-ledger store over this agent's Durable Object storage.
   * Ledger keys live under screener:task: / screener:idem: — alongside
   * the run blobs, in the same per-account Durable Object.
   */
  private taskStore(): ScreenerTaskStore {
    const storage = this.ctx.storage as any;
    return {
      get: async (key: string): Promise<string | null> => {
        try {
          const v = await storage.get(`screener:${key}`);
          return typeof v === "string" ? v : null;
        } catch {
          return null;
        }
      },
      set: async (key: string, value: string): Promise<void> => {
        await storage.put(`screener:${key}`, value);
      },
      delete: async (key: string): Promise<void> => {
        await storage.delete(`screener:${key}`);
      },
      list: async (
        prefix: string
      ): Promise<Array<{ key: string; value: string }>> => {
        try {
          const map = (await storage.list({ prefix: `screener:${prefix}` })) as Map<
            string,
            unknown
          >;
          return [...map.entries()]
            .filter(([, v]) => typeof v === "string")
            .map(([key, value]) => ({ key, value: value as string }));
        } catch {
          return [];
        }
      },
    };
  }

  private taskLedger(): ScreenerTaskLedger {
    return new ScreenerTaskLedger(this.taskStore());
  }

  /**
   * Issue #607 — durable task record for a screener run. runScreen
   * creates + begins a task before screening and resolves it on every
   * exit path; the record lives with the work in this DO.
   */
  async createScreenerTask(input: {
    trigger: "manual" | "scheduled";
    universe: string;
    sector: string;
    userLogin?: string;
    idempotencyKey: string;
  }): Promise<{ task: ScreenerTask; created: boolean }> {
    return this.taskLedger().create(input);
  }

  /** Claim + start a queued task (the run begins). */
  async beginScreenerTask(id: string): Promise<ScreenerTask> {
    const ledger = this.taskLedger();
    await ledger.claim(id);
    return ledger.start(id);
  }

  /** Issue #624: refresh a task's heartbeat during a long run. */
  async heartbeatScreenerTask(id: string): Promise<ScreenerTask> {
    return this.taskLedger().heartbeat(id);
  }

  async completeScreenerTask(
    id: string,
    outcome: {
      runTimestamp: string;
      totalScanned: number;
      matchedCount: number;
      opportunitiesCount: number;
      partial: boolean;
      evaluation: ScreenerTaskEvaluation;
    }
  ): Promise<ScreenerTask> {
    return this.taskLedger().complete(id, outcome);
  }

  /** Fail a task; escalate=true leaves it in `escalated` for a human. */
  async failScreenerTask(
    id: string,
    error: string,
    escalate: boolean
  ): Promise<ScreenerTask> {
    const ledger = this.taskLedger();
    const failed = await ledger.fail(id, error);
    return escalate
      ? ledger.escalate(id, "screener run failed; awaiting human review")
      : failed;
  }

  /** Close a task that will not run (e.g. a suppressed duplicate). */
  async cancelScreenerTask(id: string, note?: string): Promise<ScreenerTask> {
    return this.taskLedger().cancel(id, note);
  }

  async getScreenerTask(id: string): Promise<ScreenerTask | null> {
    return this.taskLedger().get(id);
  }

  async listScreenerTasks(limit = 50): Promise<ScreenerTask[]> {
    return this.taskLedger().list(limit);
  }

  /** Issue #615 (R4): active screener tasks whose heartbeat aged out. */
  async findStaleScreenerTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ScreenerTask[]> {
    return this.taskLedger().findStale(staleAfterMs);
  }

  /** Issue #615 (R4): close stale screener tasks as failed → escalated. */
  async sweepStaleScreenerTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ScreenerTask[]> {
    return this.taskLedger().sweepStale(staleAfterMs);
  }

  /** Issue #635: delete terminal task records past the retention tiers. */
  async pruneExpiredScreenerTasks(): Promise<string[]> {
    return this.taskLedger().pruneExpired();
  }

  /**
   * Issue #1993: synchronous-SQL adapter for the run lock, plus the
   * submission-gate probe the sharded path calls on this instance's
   * stub. The probe takes an explicit login: a fresh stub has no
   * recorded owner yet, and the gate knows the run's owner already.
   * These live before runScreen on purpose: the #624 heartbeat pin
   * slices runScreen's source up to the next async method, so no
   * async method may sit between runScreen and runScreenInner.
   */
  private screenRunLockCache: ScreenRunLockPort | null = null;

  /**
   * Issue #2361 (#1976 step 4e): the run lock behind its port,
   * composed over this instance's own storage. The accessor is
   * synchronous and memoized — composition executes nothing, and
   * the lock operations themselves stay synchronous (the #1993
   * atomicity the port contract requires).
   */
  private screenRunLock(): ScreenRunLockPort {
    if (!this.screenRunLockCache) {
      this.screenRunLockCache = createScreenRunLockPort(
        this.ctx.storage.sql,
        { env: this.env },
      );
    }
    return this.screenRunLockCache;
  }

  async isScreenRunning(
    universe: string,
    userLogin?: string,
  ): Promise<{ running: boolean; startedAt: number | null }> {
    const login = userLogin ?? (await this.userLogin());
    return this.screenRunLock().isRunning(login, universe || "nasdaq100");
  }

  /**
   * Issue #2223 (final slice): A2A door, cfpay signature — the edge
   * dispatcher (src/a2a) resolves the "screener" name to this class
   * on the service instance ("default", and only when a service
   * identity is configured) and calls this with the parsed body +
   * origin (a Request cannot cross the DO RPC boundary). Thin
   * delegation to the dispatch module (./screenerA2aDispatch),
   * which attributes runs to the service identity and fails closed
   * without one; the bound methods are injected here because they
   * are class-bound. Returns the collected { text, data } outcome.
   */
  async handleA2A(body: unknown, origin: string): Promise<ScreenerA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchScreenerA2A(this.env, body, {
      executor: {
        runScreen: (req) => this.runScreen(req),
        runGoalScreen: (req) => this.runGoalScreen(req),
        getLatest: () => this.getLatest(),
        getHistory: () => this.getHistory(),
        listScreenerTasks: (limit) => this.listScreenerTasks(limit),
      },
    });
    return screenerA2AOutcome(data);
  }

  /**
   * Run a screen through the one pipeline. Market data comes from the
   * run's provider (E*TRADE by default, or the Yahoo adapter) — a
   * provider failure surfaces honestly (no fallback substitution).
   */
  async runScreen(req: ScreenerRunRequest): Promise<ScreenerRunResult> {
    const timestamp = new Date().toISOString();
    const cfg = DEFAULT_SCREENER_CONFIG;
    // Issue #828: prevent concurrent runs for same user/universe.
    // Multiple clicks were spawning parallel runs that exhausted the
    // Cloudflare subrequest budget and spammed Slack with partials.
    // Issue #1185: the run's owner is the request's threaded login;
    // record it at entry so later reads on this instance resolve to
    // the same owner. Without one, the recorded/derived owner applies.
    // Issue #1993: the lock lives in this instance's own SQLite and is
    // acquired synchronously — the old async-KV check-then-act let two
    // truly simultaneous calls both pass. Same scope (user + universe)
    // and same 5-minute stale takeover, now atomic. The monolithic
    // scheduled / Trigger-Now path delegates here on this same
    // per-owner instance, so this one lock covers manual, scheduled,
    // Trigger-Now, and workflow runs alike.
    if (req.userLogin) await this.recordOwner(req.userLogin);
    const lockLogin = await this.userLogin();
    const lockUniverse = req.universe || "nasdaq100";
    const lock = this.screenRunLock().acquire(lockLogin, lockUniverse);
    if (!lock.acquired) {
      const age = lock.startedAt ? Math.round((Date.now() - lock.startedAt) / 1000) : 0;
      throw new Error(`Screen already running for ${lockUniverse} (started ${age}s ago). Please wait for it to complete.`);
    }
    if (lock.tookOverStale) {
      console.warn(`[ScreenerAgent] Stale lock detected, taking over.`);
    }
    try {
      return await this.runScreenInner(req, timestamp, cfg);
    } finally {
      // Always release the lock, even on failure.
      this.screenRunLock().release(lockLogin, lockUniverse, lock.token);
    }
  }

  private async runScreenInner(req: ScreenerRunRequest, timestamp: string, cfg: typeof DEFAULT_SCREENER_CONFIG): Promise<ScreenerRunResult> {
    // Issue #706: read active learnings at run start; log which ones applied.
    let appliedLearnings: string[] = [];
    try {
      const { getActiveLearnings } = await import("../services/learnings");
      const learnings = getActiveLearnings(this.sql, "screener");
      appliedLearnings = learnings.map((l) => `${l.id}: ${l.observation.slice(0, 80)}`);
      if (learnings.length > 0) {
        console.log(`[ScreenerAgent] Applied ${learnings.length} learnings:`, appliedLearnings);
      }
    } catch {}
    // Issue #421: a run's sector label states what was actually screened.
    // When no sector was selected, the screen covered every sector in the
    // universe → "ALL" (header renderers suppress it) — never the config
    // default, which made NASDAQ100 reports claim "Technology sector".
    const sector = req.sector || req.filters?.sector || "ALL";
    const screener = new DynamicMarketScreener();
    const userLogin = req.userLogin || (await this.userLogin());
    const universe: UniverseId = req.universe ?? "TECH";
    // Issue #1007: the run's data provider (default E*TRADE). Recorded
    // on every result — success, duplicate and failure alike — so the
    // canonical report provenance always names its provider.
    const provider: StockScreenProvider = req.provider ?? "etrade";
    // Issue #1527: carry the fallback marker onto every result the
    // run produces, so provenance names the fallback, not the
    // configured provider's live run.
    const providerFallback = req.providerFallback;
    let expectedCount = 0;

    // Issue #607: durable task record for this run (mandate §6; design
    // in docs/agents/agentic-architecture.md §5/§7). Scheduled runs key
    // on their minute slot — the same identity claimScheduledExecution
    // dedups on — so duplicate deliveries share one record; manual
    // runs key on their own timestamp. Ledger failures never break a
    // screen: warn and continue untracked.
    let taskId: string | null = null;
    // Issue #1157 (E2): the platform run id for E*TRADE-provider
    // runs — minted when the run's quote deps are bound (below),
    // stamped on the result (success and failure alike).
    let platformRunId: string | undefined;
    try {
      const created = await this.createScreenerTask({
        trigger: req.trigger,
        universe,
        sector,
        userLogin,
        idempotencyKey:
          req.trigger === "scheduled"
            ? `screener:scheduled:${universe}:${sector}:${timestamp.slice(0, 16)}`
            : `screener:manual:${universe}:${sector}:${timestamp}`,
      });
      taskId = created.task.id;
      if (created.task.status === "queued") {
        await this.beginScreenerTask(taskId);
      }
    } catch (err) {
      console.warn(
        `[ScreenerAgent] Screener task ledger unavailable (create/begin): ${err instanceof Error ? err.message : String(err)}`
      );
      taskId = null;
    }

    // Issue #624: phase-checkpoint heartbeats for this run's task,
    // throttled to at most one ledger write per minute, so a long run
    // never looks stale (#615) without amplifying storage writes.
    let lastHeartbeatMs = Date.now();
    const beat = async (): Promise<void> => {
      if (!taskId) return;
      const nowMs = Date.now();
      if (nowMs - lastHeartbeatMs < SCREENER_HEARTBEAT_MIN_MS) return;
      lastHeartbeatMs = nowMs;
      try {
        await this.heartbeatScreenerTask(taskId);
      } catch {
        // Ledger is best-effort; a missed heartbeat never breaks a screen.
      }
    };

    try {
      if (req.trigger === "scheduled" && !(await this.claimScheduledExecution(`stock:${universe}`, req.environment))) {
        const dupResult: ScreenerRunResult = {
          timestamp,
          trigger: req.trigger,
          provider,
          ...(providerFallback ? { providerFallback } : {}),
          universe,
          sector,
          success: false,
          totalScanned: 0,
          expectedCount: 0,
          matchedCount: 0,
          opportunities: [],
          allStocks: [],
          discoveryMessage: "Duplicate scheduled delivery suppressed for this account, environment, universe, and minute.",
          skippedDuplicate: true,
          ...(taskId ? { taskId } : {}),
        };
        // Issue #607: a suppressed duplicate closes as cancelled —
        // it never ran, so it must not read as completed or failed.
        if (taskId) {
          try {
            await this.cancelScreenerTask(
              taskId,
              "duplicate scheduled delivery suppressed"
            );
          } catch {
            // Ledger is best-effort; the suppression result stands.
          }
        }
        return dupResult;
      }
      // Issue #1007: the E*TRADE service is constructed only for
      // E*TRADE-provider runs. A Yahoo-provider run never touches the
      // broker (no credentials read, no token lookup) and never falls
      // back to it.
      const etrade = provider === "etrade"
        ? new ETradeService(
            this.getOrm(),
            this.env,
            userLogin,
            req.environment
          )
        : null;

      // Issue #270: resolve the universe to symbols (listings directory
      // = symbol membership only, not market data). E*TRADE-only quotes.
      // Issue #1368: universe resolution acquires through the
      // data-provider platform, mirroring the #1317 yahoo cutover:
      // bootstrap this DO's platform store (seed + routes), verify
      // + enable nasdaq through the lifecycle API when it is not
      // already enabled, resolve the screenUniverse route's primary
      // assignment to the nasdaq adapter, and bind the listings
      // fetch over it (capture + outcome tracking ride along under
      // the run id, minted here when no provider block has minted
      // one yet — the etrade/yahoo blocks reuse it via ??=, so the
      // listings capture shares the screen's run id).
      const universeDef = UNIVERSES[universe];
      let symbols = req.symbols;
      if (!symbols && universe !== "ALL") {
        await this.platformBootstrap();
        platformRunId ??= crypto.randomUUID();
        const nasdaqConfig = await this.platformConfig("nasdaq");
        if (!nasdaqConfig || nasdaqConfig.lifecycleState !== "enabled" || !nasdaqConfig.enabled) {
          await this.platformTransition("nasdaq", "verify", userLogin, {
            verifier: async () => verifyNasdaqDataProvider(),
          });
          await this.platformTransition("nasdaq", "enable", userLogin, {});
        }
        const nasdaqRegistry = new DataProviderRegistry();
        const nasdaqAdapter = createNasdaqDataProvider(undefined, {
          capture: await this.platformCaptureDeps(),
        });
        nasdaqRegistry.register(nasdaqAdapter);
        const nasdaqProvider = nasdaqUniverseProviderFromRoute(
          nasdaqRegistry,
          await this.platformConfigs(),
          await this.platformRoutes()
        );
        const nasdaqUniverseDeps = bindNasdaqUniverseDeps(nasdaqProvider, {
          runId: platformRunId,
          userLogin,
        });
        const listings = await nasdaqUniverseDeps.fetchListings();
        symbols = resolveUniverse(universe, listings);
      }
      const requestedMaxSymbols = req.maxSymbols ?? universeDef.defaultMaxSymbols;
      const selectedSymbols = symbols
        ? (requestedMaxSymbols > 0 ? symbols.slice(0, requestedMaxSymbols) : symbols)
        : [];
      expectedCount = selectedSymbols.length;
      // Issue #816: create a QuoteTrace to capture the pipeline details for the UI.
      const { QuoteTrace } = await import("../trading");
      const quoteTrace = new QuoteTrace();
      quoteTrace.setNasdaqSymbols(selectedSymbols.map(s => typeof s === 'string' ? s : s.symbol));
      // Issue #1356: E*TRADE-provider runs acquire through the
      // platform quote seam (replacing the E2 LiveScreenerDeps
      // binding): bootstrap this DO's platform store (seed +
      // enable etrade — no separate verify→enable step, unlike the
      // nasdaq/yahoo blocks), mint the run id, construct the
      // adapter over the session-scoped ETradeService (D2: the
      // from-env fallback login is not equivalent to this
      // construction, so the service stays the adapter's fetcher),
      // resolve the quotes route's etrade primary, and
      // bind the pipeline deps over it (batch via getQuotesBatch,
      // per-symbol via getQuote — the QuoteTrace rides along
      // unchanged through the adapter options, capture + outcome
      // tracking under the run id). Non-E*TRADE modes are
      // untouched. (The deps type is taken from the binding
      // helper's return — the #290 boundary keeps trading-internal
      // type paths out of this module; only the barrel is imported.)
      let platformQuoteDeps: ReturnType<typeof bindEtradeQuoteDeps> | undefined;
      if (etrade) {
        await this.platformBootstrap();
        platformRunId ??= crypto.randomUUID();
        const etradeAdapter = createETradeDataProvider(etrade, {
          capture: await this.platformCaptureDeps(),
          trace: quoteTrace,
        });
        const etradeRegistry = new DataProviderRegistry();
        etradeRegistry.register(etradeAdapter);
        const etradeProvider = etradeQuoteProviderFromRoute(
          etradeRegistry,
          await this.platformConfigs(),
          await this.platformRoutes()
        );
        platformQuoteDeps = bindEtradeQuoteDeps(etradeProvider, {
          runId: platformRunId,
          userLogin,
        });
      }
      // Issue #1317: Yahoo-provider runs acquire through the
      // data-provider platform, mirroring the E2 etrade cutover:
      // bootstrap this DO's platform store (seed + routes), verify
      // + enable yahoo through the lifecycle API when it is not
      // already enabled, resolve the quotes route's gap-fill
      // assignment to the yahoo adapter, and bind the pipeline deps
      // over it (batch via getQuotesBatch, per-symbol via getQuote
      // — capture + outcome tracking ride along under the run id).
      // A Yahoo-provider run never touches the broker (no
      // ETradeService constructed) and never falls back to it. The
      // req.yahooDeps seam stays as a test override.
      let platformYahooDeps: ReturnType<typeof bindYahooScreenerDeps> | undefined;
      if (provider === "yahoo" && !req.yahooDeps) {
        await this.platformBootstrap();
        platformRunId ??= crypto.randomUUID();
        const yahooConfig = await this.platformConfig("yahoo");
        if (!yahooConfig || yahooConfig.lifecycleState !== "enabled" || !yahooConfig.enabled) {
          await this.platformTransition("yahoo", "verify", userLogin, {
            verifier: async () => verifyYahooDataProvider(this.env),
          });
          await this.platformTransition("yahoo", "enable", userLogin, {});
        }
        const yahooRegistry = new DataProviderRegistry();
        const yahooAdapter = createYahooDataProvider(new YahooFinanceProvider(this.env), this.env, {
          capture: await this.platformCaptureDeps(),
          // Issue #1745: pipeline Yahoo quotes run behind the yahoo
          // breaker (stale-cache fallback on trip).
          breaker: defaultBreakerRegistry().breakerFor("yahoo"),
        });
        yahooRegistry.register(yahooAdapter);
        const yahooProvider = yahooQuoteProviderFromRoute(
          yahooRegistry,
          await this.platformConfigs(),
          await this.platformRoutes()
        );
        platformYahooDeps = bindYahooScreenerDeps(yahooProvider, {
          runId: platformRunId,
          userLogin,
        });
      }
      // Issue #1331: technicals history through the platform —
      // the historicalBars route's yahoo primary, resolved with
      // capture + outcome tracking under the run id (shared with
      // the quotes/etrade blocks via platformRunId). The
      // technicals leg runs for every screen (both providers), so
      // yahoo is verified→enabled here when the quotes block did
      // not already enable it — the run depends on yahoo for
      // history exactly as it always fetched it directly.
      platformRunId ??= crypto.randomUUID();
      // Issue #1331 (fix): resolution failure degrades to a
      // null-fetching deps object, so the batch still runs (chunking
      // + heartbeat beat intact) and every symbol gets honest null
      // technicals — the screen itself never fails on history
      // resolution. See resolveYahooHistoryDeps.
      const platformPorts = await this.dataProviderPorts();
      const platformHistoryDeps = (await resolveYahooHistoryDeps({
        sql: this.ctx.storage.sql,
        env: this.env,
        userLogin,
        blobStorage: this.ctx.storage,
        runId: platformRunId,
        ...(platformPorts.config ? { configPort: platformPorts.config } : {}),
        ...(platformPorts.captures ? { capturePort: platformPorts.captures } : {}),
      })) ?? { fetchBars: async () => null };
      // Provider-scoped acquisition (#261, #1007). Symbols come from
      // the listings directory (membership, not market data) for both
      // providers; quotes come from the named provider or nothing.
      const acquired = provider === "yahoo"
        ? await acquireUniverse({
            mode: "yahoo",
            symbols: selectedSymbols,
            maxSymbols: selectedSymbols.length,
            yahooDeps:
              req.yahooDeps ??
              platformYahooDeps!,
          })
        : await acquireUniverse({
            mode: "etrade-only",
            symbols: selectedSymbols,
            maxSymbols: selectedSymbols.length,
            quoteDeps: platformQuoteDeps!,
          });
      await beat();
      const screenResult = screenUniverse(screener, acquired, {
        ...(req.filters ?? {}),
        sector,
      });

      // Issue #269: Yahoo history complement — real RSI/MACD/gaps.
      // E*TRADE stays the primary quote source; Yahoo fills only the
      // history-shaped hole. Per-symbol failures → honest nulls.
      // Issue #1331: bars come through the platform history deps
      // (bound above); the throttled beat stays the onBatch hook.
      const technicalsBySymbol = await fetchPlatformTechnicalsBatch(
        platformHistoryDeps,
        acquired.quotes.map((q) => q.symbol),
        { onBatch: () => beat() }
      );
      // Issue #1184 (#1173 R2): record technicals coverage on the
      // result — symbols quoted vs symbols with real MACD / gap
      // values. Zero coverage after a throttle storm is now visible
      // in the run record instead of silently blank columns.
      const technicalsCoverage = {
        symbols: acquired.quotes.length,
        withMacd: [...technicalsBySymbol.values()].filter((t) => t.macdLine != null).length,
        withGap: [...technicalsBySymbol.values()].filter((t) => t.gapPercent != null).length,
      };

      // Issue #266: SA-style factor grades, computed percentile-relative
      // across the full scanned universe, then joined onto opportunities.
      const allStocks = attachTechnicals(
        attachFactorGrades(buildAllStocks(acquired.quotes, screenResult.stocks)),
        technicalsBySymbol
      );
      const bySymbol = new Map(allStocks.map((s) => [s.symbol, s]));
      let opportunities = selectStandouts(
        screenResult.stocks,
        req.maxItems ?? cfg.acquisition.defaultMaxItems
      ).map((s) => {
        const opp = toOpportunityStock(s);
        const graded = bySymbol.get(s.symbol);
        return graded
          ? { ...opp, factorGrades: graded.factorGrades, technicals: graded.technicals }
          : opp;
      });

      // Issue #17: portfolio context (opt-in). The modifier runs only
      // on E*TRADE-provider runs with a broker in scope — Yahoo runs
      // never touch the broker, so they cannot load a book. Every
      // failure degrades to the unmodified ranking plus a marker
      // reason; the run itself never fails for a modifier.
      let portfolioContext: PortfolioContextMarker | undefined;
      if (req.portfolioContext === true) {
        if (provider !== "etrade" || !etrade) {
          portfolioContext = { applied: false, reason: "no-broker" };
        } else {
          try {
            const { account, positions } = await etrade.fetchPortfolioRemote(
              undefined,
              true
            );
            const outcome = applyPortfolioContextToOpportunities(
              opportunities,
              {
                ok: true,
                accountId: account.accountId,
                positions: positions.map((p) => ({
                  symbol: p.symbol,
                  marketValue: p.marketValue,
                })),
              }
            );
            opportunities = outcome.ranked;
            portfolioContext = outcome.marker;
          } catch {
            portfolioContext = {
              applied: false,
              reason: "positions-unavailable",
            };
          }
        }
      }

      const result: ScreenerRunResult = {
        timestamp,
        trigger: req.trigger,
        provider,
        ...(providerFallback ? { providerFallback } : {}),
        universe,
        sector,
        success: true,
        totalScanned: screenResult.totalScanned,
        expectedCount,
        matchedCount: screenResult.matchedCount,
        opportunities,
        allStocks,
        discoveryMessage: acquired.discovery.message,
        technicalsCoverage,
        filterSummary: screenResult.filterSummary,
        ...(acquired.partial ? { partial: acquired.partial } : {}),
        // Issue #728: rejection reasons for the Slack breakdown.
        ...(screenResult.ledger?.rejections?.length
          ? { rejections: screenResult.ledger.rejections }
          : {}),
        // Issue #17: portfolio-context marker (only when requested).
        ...(portfolioContext ? { portfolioContext } : {}),
      };
      if (taskId) result.taskId = taskId;
      // Issue #1157 (E2): stamp the platform run id (E*TRADE runs).
      if (platformRunId) result.runId = platformRunId;
      // Issue #706: record which learnings were applied.
      if (appliedLearnings.length > 0) result.appliedLearnings = appliedLearnings;
      // Issue #816: attach the quote pipeline trace summary for the UI.
      const traceSummary = quoteTrace.complete();
      result.quoteTrace = {
        traceId: traceSummary.traceId,
        symbolCount: traceSummary.uniqueSymbolCount,
        batchCount: traceSummary.batchesTotal,
        quotesReceived: traceSummary.quotesReceived,
        quotesFailed: traceSummary.quotesFailed,
        failuresByCategory: traceSummary.failuresByCategory as Record<string, number>,
        batches: [], // Detailed batch info available in logs via traceId
      };

      await beat();
      await this.persistRun(result);
      // Issue #607: complete the task with a deterministic honesty
      // evaluation of the outcome. Best-effort — the run stands either way.
      if (taskId) {
        try {
          const evaluation = evaluateScreenerOutcome(
            {
              success: result.success,
              runTimestamp: result.timestamp,
              totalScanned: result.totalScanned,
              matchedCount: result.matchedCount,
              opportunities: result.opportunities.length,
              partial: !!result.partial,
              qualificationPresent: !!result.partial,
              error: result.error ?? null,
            },
            new Date().toISOString()
          );
          await this.completeScreenerTask(taskId, {
            runTimestamp: result.timestamp,
            totalScanned: result.totalScanned,
            matchedCount: result.matchedCount,
            opportunitiesCount: result.opportunities.length,
            partial: !!result.partial,
            evaluation,
          });
        } catch (err) {
          console.warn(
            `[ScreenerAgent] Screener task ledger unavailable (complete): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      return result;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Screener failed";
      const result: ScreenerRunResult = {
        timestamp,
        trigger: req.trigger,
        provider,
        ...(providerFallback ? { providerFallback } : {}),
        universe,
        sector,
        success: false,
        totalScanned: 0,
        expectedCount,
        matchedCount: 0,
        opportunities: [],
        allStocks: [],
        discoveryMessage: "",
        error: message,
        ...(taskId ? { taskId } : {}),
        ...(platformRunId ? { runId: platformRunId } : {}),
      };
      await this.persistRun(result);
      // Issue #607: a failed screen escalates its task for a human
      // instead of existing only as a result blob nobody may open.
      if (taskId) {
        try {
          await this.failScreenerTask(taskId, message, true);
        } catch {
          // Ledger is best-effort; the failure result stands either way.
        }
      }
      return result;
    }
  }

  /** Latest run for the unified results UI. */
  /**
   * Consolidation C1 (issue #1201, epic #1151 R1): run a goal-driven
   * screen (epic #1096 Phase 3 semantics) as a production citizen of
   * this agent — the Phase 0 registry over production engines,
   * executed under this DO's screener task ledger (the same ledger
   * store runScreen uses). The composition lives in
   * services/screeningRuntime.ts (runProductionGoalScreen); this
   * method only binds the DO-owned pieces: the ledger and the
   * E*TRADE client behind the options leg. A duplicate delivery
   * returns the existing ledger record without re-executing.
   */
  async runGoalScreen(req: {
    scenario: ScenarioDefinition;
    trigger: "manual" | "scheduled";
    idempotencyKey: string;
    userLogin?: string;
    environment?: "TEST" | "PROD";
    assetClasses?: ScreeningProviderAssetClass[];
    symbols?: string[];
    baseStockFilter?: StockScreenerFilter;
    baseOptionsFilter?: OptionScreenerFilter;
    /** Issue #1571: "yahoo" runs the stock leg on the Yahoo engine
     *  (see createYahooStockScreener). Absent keeps the default
     *  listings-feed leg. */
    provider?: "yahoo";
    /** Issue #1571: fallback marker, stamped onto the result before
     *  artifact generation so the PDF provenance names the fallback. */
    providerFallback?: {
      from: "etrade";
      reason: string;
    };
    /** Issue #1571: Yahoo fetcher override (test seam, mirroring
     *  runScreen's req.yahooDeps). Production binds the platform
     *  Yahoo provider below. */
    yahooDeps?: import("../trading").YahooScreenerDeps;
  }): Promise<{ task: ScreenerTask; executed: boolean; result?: GoalDrivenScreenResult }> {
    const userLogin = req.userLogin || (await this.userLogin());
    const etrade = new ETradeService(
      this.getOrm(),
      this.env,
      userLogin,
      req.environment
    );
    const { runProductionGoalScreen, createYahooStockScreener, createLiveStockScreener } = await import("../services/screeningRuntime");
    // Issue #1571: a Yahoo goal run binds the platform Yahoo provider
    // exactly like runScreen's #1317 block — bootstrap, verify→enable,
    // and bind the pipeline deps over the quotes route. The options
    // leg keeps its E*TRADE client (it fails per-class on auth-dead,
    // unchanged); only the stock leg is rerouted.
    let stockScreener: import("../trading").IMarketScreener | undefined;
    if (req.provider === "yahoo") {
      let yahooDeps = req.yahooDeps;
      if (!yahooDeps) {
        await this.platformBootstrap();
        const platformRunId = crypto.randomUUID();
        const yahooConfig = await this.platformConfig("yahoo");
        if (!yahooConfig || yahooConfig.lifecycleState !== "enabled" || !yahooConfig.enabled) {
          await this.platformTransition("yahoo", "verify", userLogin, {
            verifier: async () => verifyYahooDataProvider(this.env),
          });
          await this.platformTransition("yahoo", "enable", userLogin, {});
        }
        const yahooRegistry = new DataProviderRegistry();
        const yahooAdapter = createYahooDataProvider(new YahooFinanceProvider(this.env), this.env, {
          capture: await this.platformCaptureDeps(),
          // Issue #1745: pipeline Yahoo quotes run behind the yahoo
          // breaker (stale-cache fallback on trip).
          breaker: defaultBreakerRegistry().breakerFor("yahoo"),
        });
        yahooRegistry.register(yahooAdapter);
        const yahooProvider = yahooQuoteProviderFromRoute(
          yahooRegistry,
          await this.platformConfigs(),
          await this.platformRoutes()
        );
        yahooDeps = bindYahooScreenerDeps(yahooProvider, {
          runId: platformRunId,
          userLogin,
        });
      }
      stockScreener = createYahooStockScreener(yahooDeps);
    }
    // Issue #1378: thread the routed universe seam into options
    // discovery (full capture via the agent's DO storage; the goal
    // screen's idempotency key is the caller run id — decision D2).
    // A bundle failure degrades to undefined, and discovery then
    // throws naming the seam rather than fetching directly.
    let goalUniverseDeps: import("../trading").NasdaqUniverseDeps | undefined;
    let goalBundle: Awaited<ReturnType<typeof nasdaqUniverseRouteBundle>> | undefined;
    try {
      const goalPorts = await this.dataProviderPorts();
      goalBundle = await nasdaqUniverseRouteBundle({
        sql: this.ctx.storage.sql,
        storage: this.ctx.storage,
        env: this.env,
        userLogin,
        runId: req.idempotencyKey,
        ...(goalPorts.config ? { configPort: goalPorts.config } : {}),
        ...(goalPorts.captures ? { capturePort: goalPorts.captures } : {}),
      });
      const goalNasdaqProvider = nasdaqUniverseProviderFromRoute(
        goalBundle.registry,
        goalBundle.configs,
        goalBundle.routes
      );
      goalUniverseDeps = bindNasdaqUniverseDeps(goalNasdaqProvider, goalBundle.runContext);
    } catch (err) {
      console.warn(
        `[screener-agent] universe deps unavailable for goal screen, discovery degrades to the missing-seam throw: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    // Issue #1998 (Phase 3): persisted gather for the goal stock
    // leg. The agent resolves the flag itself from its env, so both
    // direct and workflow-child goal runs gather when ON, and none
    // do when OFF. Yahoo-fallback runs keep their Yahoo engine
    // Issue #2056: the gather fetches live and Yahoo separately —
    // rows come from the live side alone, Yahoo complements columns
    // where present (never adds rows, never vetoes them). The
    // combined gap-fill seam is NOT used here, because gap-fill
    // alone cannot prove Yahoo membership for a live-served symbol.
    // Without a Yahoo gap-fill provider the Yahoo side is absent
    // and rows store with live columns only. Any binding failure
    // degrades to no hook — the leg then refuses technical filters
    // exactly as before, never a silent partial enrichment.
    let gatherEnrichment: import("../trading").ScreenLiveEnrichment | undefined;
    if (req.provider !== "yahoo") {
      try {
        const { createFeatureFlagPort } = await import("../features/createFeatureFlagPort");
        if (await createFeatureFlagPort(this.env).isEnabled("goal_workflow")) {
          const { createGoalGatherEnrichment } = await import("../services/goalGather");
          const {
            bootstrapDataProviders: gatherBootstrap,
            DataProviderRegistry: GatherRegistry,
            createETradeDataProvider: gatherEtradeAdapter,
            createYahooDataProvider: gatherYahooAdapter,
            listCapabilityRoutes: gatherListRoutes,
            listProviderConfigs: gatherListConfigs,
            quotesProvidersFromRoute: gatherQuotesFromRoute,
            bindEtradeQuoteDeps: gatherBindLive,
            bindYahooQuoteDeps: gatherBindYahoo,
            resolveYahooHistoryDeps: gatherResolveHistory,
          } = await import("../trading");
          const { createObservabilitySink } = await import("../observability/createObservabilityPorts");
          // #2303: the gather's platform reads/writes run through
          // the ports when bound (same store discipline as the
          // screen blocks); the sql fallbacks are unchanged.
          const gatherPorts = await this.dataProviderPorts();
          if (gatherPorts.config) await gatherPorts.config.bootstrapDataProviders();
          else gatherBootstrap(this.ctx.storage.sql);
          const gatherCaptureDeps = await this.platformCaptureDeps();
          const gatherRegistry = new GatherRegistry();
          gatherRegistry.register(
            gatherEtradeAdapter(etrade, {
              capture: gatherCaptureDeps,
            })
          );
          gatherRegistry.register(
            gatherYahooAdapter(new YahooFinanceProvider(this.env), this.env, {
              capture: gatherCaptureDeps,
              breaker: defaultBreakerRegistry().breakerFor("yahoo"),
            })
          );
          const { primary: gatherPrimary, gapFill: gatherGapFill } = gatherQuotesFromRoute(
            gatherRegistry,
            gatherPorts.config
              ? await gatherPorts.config.listProviderConfigs()
              : gatherListConfigs(this.ctx.storage.sql),
            gatherPorts.config
              ? await gatherPorts.config.listCapabilityRoutes()
              : gatherListRoutes(this.ctx.storage.sql)
          );
          // Issue #2426 (G14): the gather tenant is the run owner's
          // login — userLogin is guaranteed present here (the
          // userLogin() resolution above throws without a recorded
          // owner), so the captures this run writes and reads back
          // partition by their real owner instead of a shared
          // synthetic "default" tenant.
          const gatherRunContext = {
            runId: req.idempotencyKey,
            tenantId: userLogin,
            userLogin,
          };
          const gatherLiveQuoteDeps = gatherBindLive(gatherPrimary, gatherRunContext);
          const gatherYahooQuoteDeps = gatherGapFill
            ? gatherBindYahoo(gatherGapFill, gatherRunContext)
            : undefined;
          const gatherHistoryDeps = await gatherResolveHistory({
            sql: this.ctx.storage.sql,
            env: this.env,
            userLogin,
            blobStorage: this.ctx.storage,
            runId: req.idempotencyKey,
            ...(gatherPorts.config ? { configPort: gatherPorts.config } : {}),
            ...(gatherPorts.captures ? { capturePort: gatherPorts.captures } : {}),
          });
          gatherEnrichment = createGoalGatherEnrichment({
            sql: this.ctx.storage.sql,
            blobStorage: this.ctx.storage,
            blobEnv: this.env,
            ...(gatherPorts.captures ? { capturePort: gatherPorts.captures } : {}),
            ...(gatherPorts.config ? { configPort: gatherPorts.config } : {}),
            // Issue #2426: same disposition as gatherRunContext
            // above — the enrichment reads back this run's captures
            // under the owner's login, not a shared "default" tenant.
            tenantId: userLogin,
            userLogin,
            runId: req.idempotencyKey,
            liveQuoteDeps: gatherLiveQuoteDeps,
            ...(gatherYahooQuoteDeps ? { yahooQuoteDeps: gatherYahooQuoteDeps } : {}),
            ...(gatherHistoryDeps ? { historyDeps: gatherHistoryDeps } : {}),
            sink: createObservabilitySink(this.env),
          });
        }
      } catch (err) {
        const attachError = err instanceof Error ? err.message : String(err);
        console.warn(
          `[screener-agent] goal gather unavailable, technical filters refuse as before: ${attachError}`
        );
        // Issue #1999: an attach failure is a gather failure, not
        // a silent no-hook. The stub throws into screenLive's
        // failed-gather path when a technical filter needs it;
        // filters that need no enrichment never call it, so
        // flag-OFF and Yahoo runs are unchanged.
        gatherEnrichment = {
          enrich: async () => {
            throw new Error(attachError);
          },
        };
      }
    }
    // Issue #1686: non-Yahoo goal screens previously defaulted to a
    // no-seam listings screener, so the stock leg returned the
    // missing-seam error result. Reuse the storage-carrying goal
    // bundle (built above for options discovery) as the stock leg's
    // seam: the stock leg now fetches live + captures under the
    // caller run id (D2, same id as discovery). Yahoo runs keep
    // their Yahoo screener; a failed bundle keeps today's error
    // result (no regression — the default still applies).
    if (!stockScreener && goalBundle) {
      stockScreener = createLiveStockScreener(new DynamicMarketScreener(), {
        universeRoute: goalBundle,
        ...(gatherEnrichment ? { enrichment: gatherEnrichment } : {}),
      });
    }
    const out = await runProductionGoalScreen({
      ledger: this.taskLedger(),
      ...(stockScreener ? { stockScreener } : {}),
      optionsScreener: new DynamicOptionsScreener(etrade.client, undefined, goalUniverseDeps),
      scenario: req.scenario,
      trigger: req.trigger,
      idempotencyKey: req.idempotencyKey,
      userLogin,
      assetClasses: req.assetClasses,
      symbols: req.symbols,
      baseStockFilter: req.baseStockFilter,
      baseOptionsFilter: req.baseOptionsFilter,
    });
    // Issue #1335: every completed goal-screen run — 0 hits included —
    // leaves PDF + XLSX + CSV artifacts in the blob store, mirroring
    // generateRunPdf for stock runs. Artifact failure is recorded on
    // the result, never thrown: the run completed, the artifact did not.
    if (out.executed && out.result) {
      // Issue #1571: stamp the fallback marker BEFORE artifact
      // generation so the goal PDF provenance names the fallback.
      if (req.providerFallback && !out.result.providerFallback) {
        out.result.providerFallback = req.providerFallback;
      }
      if (req.provider && !out.result.provider) {
        out.result.provider = req.provider;
      }
      const { generateAndStoreGoalScreenArtifacts } = await import(
        "../services/goalScreenReports"
      );
      const artifacts = await generateAndStoreGoalScreenArtifacts(
        this.env,
        this.ctx.storage as any,
        out.result
      );
      Object.assign(out.result, artifacts);
    }
    return out;
  }

  async getLatest(): Promise<ScreenerRunResult | null> {
    return (await this.ctx.storage.get<ScreenerRunResult>(LATEST_KEY)) ?? null;
  }

  /** Recent run history, newest first (capped). */
  async getHistory(): Promise<ScreenerRunResult[]> {
    return (await this.ctx.storage.get<ScreenerRunResult[]>(HISTORY_KEY)) ?? [];
  }

  /**
   * Sharded run (issue #270): "ALL" fans out into parallel per-universe
   * screens. Each shard runs the full pipeline (E*TRADE + Yahoo + grades +
   * PDF) and persists under its own universe key. Returns one result per
   * universe, in shardableUniverses() order.
   */
  async runSharded(
    req: Omit<ScreenerRunRequest, "universe" | "symbols">
  ): Promise<ScreenerRunResult[]> {
    const shards = shardableUniverses();
    return Promise.all(
      shards.map((universe) => this.runScreen({ ...req, universe }))
    );
  }

  /**
   * Latest report PDF (issue #269, #297) — generated at run time, served by
   * GET /api/screener/report.pdf and attached to Slack/email deliveries.
   * Issue #297: Also stores per-run PDFs with unique keys to prevent
   * franken-PDFs from concurrent runs overwriting each other.
   * Issue #605: blobs live in R2 when bound, else legacy DO storage.
   */
  async getLatestPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, PDF_LATEST_KEY);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), PDF_LATEST_KEY);
  }

  /**
   * Get a specific run's PDF by its storage key (issue #297).
   */
  async getPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, pdfKey);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), pdfKey);
  }

  /**
   * Latest report XLSX — generated at run time, served by GET /api/screener/report.xlsx.
   */
  async getLatestXlsx(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, XLSX_LATEST_KEY);
  }

  /**
   * Get a specific run's XLSX report by its storage key.
   */
  async getXlsxByKey(xlsxKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, xlsxKey);
  }

  /**
   * Issue #1346: get a specific run's CSV report by its storage
   * key. Prefix-validated like getGoalScreenArtifactByKey — a
   * non-CSV key never reads another family's blob through this
   * getter, so /api/screener/report.csv cannot serve a PDF/XLSX.
   */
  async getCsvByKey(csvKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { isScreenerCsvKey } = await import("../trading");
    if (!isScreenerCsvKey(csvKey)) return null;
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, csvKey);
  }

  /** Latest report CSV — generated at run time, served by GET /api/screener/report.csv. */
  async getLatestCsv(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, CSV_LATEST_KEY);
  }

  /**
   * Issue #1335: one getter for all three goal-screen artifact formats.
   * The key must be goal_screen-namespaced — this getter never serves
   * stock/options blobs, so a goal-screen download link cannot be
   * repurposed into an open blob read.
   */
  async getGoalScreenArtifactByKey(
    key: string
  ): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { isGoalScreenArtifactKey } = await import("../services/goalScreenReports");
    if (!isGoalScreenArtifactKey(key)) return null;
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, key);
  }

  /**
   * Get the latest options PDF (issue #361).
   */
  async getLatestOptionsPdf(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, OPTIONS_PDF_LATEST_KEY);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), OPTIONS_PDF_LATEST_KEY);
  }

  /**
   * Issue #2180: serve a stored discovery run report (PDF/XLSX/CSV) by key.
   * The artifacts live in the same blob store the report routes read.
   */
  async getDiscoveryReportByKey(key: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, key);
  }

  /**
   * Get a specific options run's PDF by its storage key (issue #361).
   */
  async getOptionsPdfByKey(pdfKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    const local = await getReportPdf(this.env, this.ctx.storage, pdfKey);
    if (local) return local;
    const { getPdfAsset } = await import("./report-asset-agent");
    return await getPdfAsset(this.env, await this.userLogin(), pdfKey);
  }

  /**
   * Issue #1195 (#1173 R3b): generate an options run's XLSX report
   * and store it under a per-run key (+ the latest pointer), the
   * options twin of the stock XLSX block in persistRun. Throws on
   * failure — callers record xlsxStatus "failed" with the error,
   * mirroring the stock convention.
   */
  async generateAndStoreOptionsXlsx(
    result: import("../types").OptionScreenResult,
  ): Promise<{ key: string; fileName: string }> {
    // Issue #1278 (#1173 R5): generate+store retries under the R1 report
    // policy, mirroring the stock XLSX block in persistRun.
    const { withRetry } = await import("../services/resilience");
    const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
    const reportRetry = resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report;
    const key = `${OPTIONS_XLSX_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
    return withRetry(async () => {
      const { generateOptionsXlsx, optionsXlsxFileName } = await import("../trading");
      const { putReportPdf } = await import("../services/reportBlobStore");
      const bytes = generateOptionsXlsx(result);
      const fileName = optionsXlsxFileName(result);
      await putReportPdf(this.env, this.ctx.storage as any, key, fileName, bytes);
      await putReportPdf(this.env, this.ctx.storage as any, OPTIONS_XLSX_LATEST_KEY, fileName, bytes);
      return { key, fileName };
    }, reportRetry, { label: "options-xlsx" });
  }

  /** Get a specific options run's XLSX report by its storage key (#1195). */
  async getOptionsXlsxByKey(xlsxKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, xlsxKey);
  }

  /**
   * Issue #1346: generate an options run's CSV report and store it
   * under a per-run key (+ the latest pointer), the options twin
   * of generateAndStoreOptionsXlsx. Throws on failure — callers
   * record csvStatus "failed" with the error, mirroring the XLSX
   * convention. A 0-contract run stores a headers-only CSV.
   */
  async generateAndStoreOptionsCsv(
    result: import("../types").OptionScreenResult,
  ): Promise<{ key: string; fileName: string }> {
    const { withRetry } = await import("../services/resilience");
    const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
    const reportRetry = resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report;
    const key = `options:csv:${crypto.randomUUID().slice(0, 8)}`;
    return withRetry(async () => {
      const { generateOptionsCsv, optionsCsvFileName } = await import("../trading");
      const { putReportPdf } = await import("../services/reportBlobStore");
      const bytes = new TextEncoder().encode(generateOptionsCsv(result));
      const fileName = optionsCsvFileName(result);
      await putReportPdf(this.env, this.ctx.storage as any, key, fileName, bytes, "text/csv");
      await putReportPdf(this.env, this.ctx.storage as any, OPTIONS_CSV_LATEST_KEY, fileName, bytes, "text/csv");
      return { key, fileName };
    }, reportRetry, { label: "options-csv" });
  }

  /** Get a specific options run's CSV report by its storage key (#1346, prefix-validated). */
  async getOptionsCsvByKey(csvKey: string): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { isOptionsCsvKey } = await import("../trading");
    if (!isOptionsCsvKey(csvKey)) return null;
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, csvKey);
  }

  /** Get the latest options CSV report (#1346). */
  async getLatestOptionsCsv(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, OPTIONS_CSV_LATEST_KEY);
  }

  /** Get the latest options XLSX report (#1195). */
  async getLatestOptionsXlsx(): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    const { getReportPdf } = await import("../services/reportBlobStore");
    return await getReportPdf(this.env, this.ctx.storage, OPTIONS_XLSX_LATEST_KEY);
  }

  /**
   * Generate + store the strategy screener's PDF/XLSX/CSV for one run.
   *
   * Strategy screens (both fit directions and the AI actions) store
   * these under the existing options key families, so the established
   * /api/options/report.pdf|xlsx|csv endpoints serve them with no new
   * route surface. Each format has its own failure domain and retry
   * policy (#1278): a failed format is recorded, never fatal.
   */
  async generateAndStoreStrategyReport(
    input: import("../trading").StrategyReportInput,
  ): Promise<import("../trading").StrategyReportArtifactOutcome> {
    const { withRetry } = await import("../services/resilience");
    const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
    const { putReportPdf } = await import("../services/reportBlobStore");
    const {
      generateStrategyReportPdf,
      generateStrategyReportXlsx,
      generateStrategyReportCsv,
      strategyReportFileName,
    } = await import("../trading");
    const policy = resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report;
    const id = crypto.randomUUID().slice(0, 8);
    const outcome: import("../trading").StrategyReportArtifactOutcome = {
      pdfStatus: "failed",
      xlsxStatus: "failed",
      csvStatus: "failed",
    };

    try {
      const key = `options:pdf:strategy:${id}`;
      const bytes = await generateStrategyReportPdf(input);
      await withRetry(
        () => putReportPdf(this.env, this.ctx.storage as any, key, strategyReportFileName(input, "pdf"), bytes),
        policy,
        { label: "strategy-pdf" },
      );
      outcome.pdfKey = key;
      outcome.pdfStatus = "generated";
    } catch (err) {
      outcome.pdfError = err instanceof Error ? err.message : String(err);
      console.error("[ScreenerAgent] Strategy PDF generation failed:", outcome.pdfError);
    }

    try {
      const key = `options:xlsx:strategy:${id}`;
      const bytes = generateStrategyReportXlsx(input);
      await withRetry(
        () =>
          putReportPdf(
            this.env,
            this.ctx.storage as any,
            key,
            strategyReportFileName(input, "xlsx"),
            bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
        policy,
        { label: "strategy-xlsx" },
      );
      outcome.xlsxKey = key;
      outcome.xlsxStatus = "generated";
    } catch (err) {
      outcome.xlsxError = codedMessage("FAILURE_REPORT_XLSX_GENERATION", err instanceof Error ? err.message : String(err));
      console.error("[ScreenerAgent] Strategy XLSX generation failed:", outcome.xlsxError);
    }

    try {
      const key = `options:csv:strategy:${id}`;
      const bytes = new TextEncoder().encode(generateStrategyReportCsv(input));
      await withRetry(
        () =>
          putReportPdf(
            this.env,
            this.ctx.storage as any,
            key,
            strategyReportFileName(input, "csv"),
            bytes,
            "text/csv",
          ),
        policy,
        { label: "strategy-csv" },
      );
      outcome.csvKey = key;
      outcome.csvStatus = "generated";
    } catch (err) {
      outcome.csvError = codedMessage("FAILURE_REPORT_CSV_GENERATION", err instanceof Error ? err.message : String(err));
      console.error("[ScreenerAgent] Strategy CSV generation failed:", outcome.csvError);
    }

    return outcome;
  }

  private async persistRun(result: ScreenerRunResult): Promise<void> {
    // Issue #269/#914: PDF generation + storage lives in generateRunPdf
    // (shared with regeneration, #1278).
    // Issue #1793: Generate PDF + XLSX BEFORE writing result into storage
    // so LATEST and HISTORY retain pdfKey, pdfStatus, xlsxKey, and xlsxStatus.
    await this.generateRunPdf(result);

    // XLSX Multi-tab report generation (Screened Stocks + Formulas & Methodology)
    // Issue #1278 (#1173 R5): generate+store retries under the R1 report
    // policy — a transient blob-store failure no longer fails the XLSX.
    try {
      const { putReportPdf } = await import("../services/reportBlobStore");
      const { withRetry } = await import("../services/resilience");
      const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
      const reportRetry = resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report;
      const xlsxKey = `${XLSX_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
      await withRetry(async () => {
        const { generateScreenerXlsx, screenerXlsxFileName } = await import("../trading");
        const xlsxBytes = generateScreenerXlsx(result);
        const xlsxFileName = screenerXlsxFileName(result);
        await putReportPdf(this.env, this.ctx.storage as any, xlsxKey, xlsxFileName, xlsxBytes);
        await putReportPdf(this.env, this.ctx.storage as any, XLSX_LATEST_KEY, xlsxFileName, xlsxBytes);
        result.xlsxKey = xlsxKey;
        result.xlsxStatus = "generated";
      }, reportRetry, { label: "screener-xlsx" });
    } catch (xlsxErr) {
      result.xlsxStatus = "failed";
      result.xlsxError = codedMessage("FAILURE_REPORT_XLSX_GENERATION", xlsxErr instanceof Error ? xlsxErr.message : String(xlsxErr));
      console.error("[ScreenerAgent] XLSX generation failed:", result.xlsxError);
    }

    // Issue #2062: every stock run records its full document set.
    await this.generateRunCsv(result);

    await this.ctx.storage.put(LATEST_KEY, result);
    const history =
      (await this.ctx.storage.get<ScreenerRunResult[]>(HISTORY_KEY)) ?? [];
    await this.ctx.storage.put(
      HISTORY_KEY,
      [result, ...history].slice(0, DEFAULT_SCREENER_CONFIG.acquisition.historyLimit)
    );
    // Issue #783: no report-store write happens here. The #732 block that
    // persisted a second copy into this DO's own report table is removed:
    // nothing read that copy. The canonical report copy for a run is
    // stored exactly once by OrchestratorAgent at generation time (the
    // store every report surface reads — Reports tab, routes, AI Search);
    // this method keeps only the delivery cache above (latest/history in
    // DO storage + the per-run PDFs).
  }

  /**
   * Issue #2062: generate + store the per-run CSV artifact.
   *
   * Every stock run records a full document set (PDF + XLSX + CSV); the
   * CSV is the machine-readable companion the Docs and Reports page links
   * beside the workbook. Same contract as the XLSX leg: retried under the
   * R1 report policy, and a real failure is recorded on the run
   * (`csvStatus` / `csvError`) instead of failing the screen.
   */
  private async generateRunCsv(result: ScreenerRunResult): Promise<void> {
    try {
      const { putReportPdf } = await import("../services/reportBlobStore");
      const { withRetry } = await import("../services/resilience");
      const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
      const { generateScreenerCsv, screenerCsvFileName, SCREENER_CSV_KEY_PREFIX } = await import("../trading");
      const reportRetry = resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report;
      const csvKey = `${SCREENER_CSV_KEY_PREFIX}${crypto.randomUUID().slice(0, 8)}`;
      await withRetry(async () => {
        const csvBytes = new TextEncoder().encode(generateScreenerCsv(result));
        const csvFileName = screenerCsvFileName(result);
        await putReportPdf(this.env, this.ctx.storage as any, csvKey, csvFileName, csvBytes, "text/csv");
        await putReportPdf(this.env, this.ctx.storage as any, CSV_LATEST_KEY, csvFileName, csvBytes, "text/csv");
        result.csvKey = csvKey;
        result.csvStatus = "generated";
      }, reportRetry, { label: "screener-csv" });
    } catch (csvErr) {
      result.csvStatus = "failed";
      result.csvError = codedMessage("FAILURE_REPORT_CSV_GENERATION", csvErr instanceof Error ? csvErr.message : String(csvErr));
      console.error("[ScreenerAgent] CSV generation failed:", result.csvError);
    }
  }

  /**
   * Issue #269: generate + store the report PDF for download/delivery.
   * Issue #297: Store with per-run key (not shared) to prevent franken-PDFs.
   * Issue #605: blobs go to R2 when bound, else legacy DO storage.
   * Issue #914: Use the unified report pipeline (shared by stock + options,
   * manual + scheduled). Mutates result.pdfKey/pdfStatus/pdfError.
   * Extracted from persistRun for #1278 so regeneration runs the exact
   * same generation path (which itself retries per #1278 part A).
   */
  private async generateRunPdf(result: ScreenerRunResult): Promise<void> {
    const { runReportPipeline } = await import("../services/unifiedReportPipeline");
    const { putReportPdf, getReportPdf } = await import("../services/reportBlobStore");
    // Issue #2088: section config — code defaults plus env overrides —
    // threaded through the pipeline to the screener generator.
    const { resolveScreenerPdfSectionConfig } = await import("../trading");
    const pdfOptions = {
      sections: resolveScreenerPdfSectionConfig(this.env as unknown as Record<string, string | undefined>),
    };
    const pipelineResult = await runReportPipeline(
      this.env,
      this.ctx.storage as any,
      {
        type: "screener",
        trigger: result.trigger === "manual" ? "manual" : "scheduled",
        result,
        userLogin: await this.userLogin(),
        title: `Market screen — ${String((result as any).universe ?? (result as any).sector ?? "ALL")}`,
        summary: result.success
          ? `Scanned ${result.totalScanned} symbols, ${result.matchedCount} matched.`
          : `Screen failed: ${(result as any).error ?? "unknown error"}.`,
        timestamp: result.timestamp,
        pdfOptions,
      }
    );
    if (pipelineResult.pdfStatus === "generated") {
      // Keep the "latest" pointer for backward compatibility.
      let stored = await getReportPdf(this.env, this.ctx.storage as any, pipelineResult.pdfKey);
      if (!stored) {
        const { getPdfAsset } = await import("./report-asset-agent");
        stored = await getPdfAsset(this.env, await this.userLogin(), pipelineResult.pdfKey);
      }
      if (stored) {
        await putReportPdf(this.env, this.ctx.storage as any, pipelineResult.pdfKey, stored.fileName, stored.bytes);
        await putReportPdf(this.env, this.ctx.storage as any, PDF_LATEST_KEY, stored.fileName, stored.bytes);
      }
      result.pdfKey = pipelineResult.pdfKey;
      result.pdfStatus = "generated";
      // A regenerated run must not keep its previous failure on record.
      delete result.pdfError;
    } else {
      // Issue #1023 (S4): NO direct-generator fallback — the unified
      // pipeline is the only PDF path (#914/#680). Issue #822: do NOT
      // swallow. Record the failure explicitly so the publisher knows
      // not to fall back to a stale PDF.
      result.pdfStatus = "failed";
      result.pdfError = pipelineResult.pdfError;
      console.error("[ScreenerAgent] PDF generation failed:", result.pdfError);
    }
  }

  /**
   * Issue #1278 (#1173 R5): regenerate the stored latest run's PDF —
   * the #1123-deferred recovery path for a run whose PDF failed. No
   * re-screen: the full run result persists in this agent's storage.
   * The outcome is written back to LATEST and the matching HISTORY
   * entry (same timestamp), so the Runs list (F3 twin inheritance)
   * surfaces the healed artifact.
   */
  async regenerateLatestReport(): Promise<{
    pdfStatus: "generated" | "failed";
    pdfKey?: string;
    pdfError?: string;
    timestamp?: string;
  }> {
    const latest = await this.ctx.storage.get<ScreenerRunResult>(LATEST_KEY);
    if (!latest) {
      const { codedMessage } = await import("../outcomes/outcomeAspects");
      return {
        pdfStatus: "failed",
        pdfError: codedMessage("FAILURE_REPORT_ARTIFACT_MISSING", "no stored screener run to regenerate"),
      };
    }
    await this.generateRunPdf(latest);
    await this.ctx.storage.put(LATEST_KEY, latest);
    const history =
      (await this.ctx.storage.get<ScreenerRunResult[]>(HISTORY_KEY)) ?? [];
    const idx = history.findIndex((r) => r.timestamp === latest.timestamp);
    if (idx >= 0) {
      history[idx] = latest;
      await this.ctx.storage.put(HISTORY_KEY, history);
    }
    return {
      pdfStatus: latest.pdfStatus === "generated" ? "generated" : "failed",
      pdfKey: latest.pdfKey,
      pdfError: latest.pdfError,
      timestamp: latest.timestamp,
    };
  }
}