/**
 * Issue #319 — ResearchAgent: the autonomous options-research agent.
 *
 * One agent owns options research end-to-end: configuration (typed, per
 * tenant), scheduled + manual runs through the single pipeline entry,
 * run history, and §9 evaluations. State lives in this DO's SQLite
 * (research_runs / research_settings / research_evaluations).
 *
 * Publication goes through the orchestrator: runResearch() returns the
 * full report and the orchestrator stores the canonical copy via the #308
 * seam (storeReportAtGeneration) on the orchestrator's mas_reports — the
 * table the Reports tab (#318) and AI Search read. This agent never writes
 * mas_reports itself, so there is exactly one searchable copy.
 *
 * READ-ONLY boundary: this agent has no import path to any order-placement
 * function (pinned by tests/research-boundary.test.ts). Research only.
 */

import { PortThink } from "../actors/thinkAdapter";
import { codedMessage } from "../outcomes/outcomeAspects";
import {
  dispatchResearchA2A,
  researchA2AOutcome,
  type ResearchA2AOutcome,
} from "./researchA2aDispatch";
import type { ActorTurnHooks } from "../actors/actorPorts";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { resolveAiModelName } from "./model";
import type { Env } from "../types";
import { createResearchStorePorts } from "../data/createResearchStorePorts";
import type { ResearchStorePorts } from "../data/researchStorePorts";
import {
  ResearchConfigService,
  RESEARCH_CONFIG_DEFAULTS,
  type ResearchConfig,
  type ResearchSettingsStore,
} from "../services/researchConfig";
import {
  runResearchPipeline,
  runResearchEvaluation,
  type TriggerSource,
  type ResearchReport,
  type ResearchEvaluation,
  type StoredIdeaRecord,
} from "../services/researchPipeline";
import { EtradeResearchDataProvider } from "../services/researchProviders";
import {
  resolveYahooHistoryDeps,
  nasdaqUniverseRouteBundle,
  nasdaqUniverseProviderFromRoute,
  bindNasdaqUniverseDeps,
  type NasdaqUniverseDeps,
} from "../trading";
import {
  runGoalScenarioDiscovery,
  persistDiscoveredGoals,
  type DiscoveredGoalProposal,
  type PortfolioDiscoveryState,
} from "../services/goalScenarioEngine";
import {
  shouldFireResearchTick,
  researchTickDateKey,
} from "../services/researchScheduleGuard";
import {
  DEFAULT_STALE_AFTER_MS,
  ResearchTaskLedger,
  type ResearchTask,
  type ResearchTaskEvaluation,
  type ResearchExecutionPath,
  type ResearchTaskStore,
} from "../services/researchTaskLedger";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "agents/research-agent",
});

/**
 * Issue #2327 (Agent Mesh S3, programme #2225 G8/G14): the retired
 * synthetic login. Research work acts under an explicit identity or
 * not at all — an absent, blank, or literally-"default" login is NO
 * identity, never a shared one (the #1185 discipline, applied to the
 * survey's §2-identity(d) fallback family). The literal is rejected
 * even when a caller passes it deliberately: it names the old
 * fallback, not a user.
 */
const RETIRED_DEFAULT_LOGIN = "default";

/**
 * Resolve a caller-supplied login to an acting identity, or null
 * when there is none. Returns the login verbatim — only its
 * presence is judged here, never rewritten.
 */
function explicitResearchLogin(value: string | undefined | null): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed === RETIRED_DEFAULT_LOGIN) return null;
  return value;
}

/** The run methods' fail-closed refusal for an identity-less request. */
const RESEARCH_IDENTITY_REQUIRED =
  "Research run requires an explicit userLogin — runs are never attributed to a default identity (issue #2327).";

const LATEST_KEY = "research:latest";
const RESEARCH_PDF_KEY_PREFIX = "research:pdf:";
const RESEARCH_PDF_LATEST_KEY = "research:pdf:latest";
const HISTORY_KEY = "research:history";
const MAX_HISTORY = 20;

export interface ResearchRunRequest {
  trigger: TriggerSource;
  userLogin?: string;
  /** Optional one-off config overrides for this run (still validated). */
  configOverride?: Partial<ResearchConfig>;
}

export interface ResearchRunResult {
  success: boolean;
  report: ResearchReport | null;
  error?: string;
}

/**
 * Issue #1122 (epic #1096 Phase 3): discovery is a research-agent RUN
 * TYPE. The scheduled variant rides the existing every-30-minutes tick behind
 * the #354 guard idiom, keyed by this agent-local marker in
 * research_settings — no new cron trigger (Workers cron ceiling).
 */
export const RESEARCH_DISCOVERY_LAST_RUN_KEY = "research_discovery_last_run";

export interface ResearchDiscoveryRunRequest {
  trigger: TriggerSource;
  userLogin?: string;
  /**
   * The caller's portfolio state, when a seam supplies one. Null (the
   * scheduled/tool path) SKIPS portfolio discovery triggers with the
   * limitation recorded — the portfolio is never assumed healthy.
   */
  portfolio?: PortfolioDiscoveryState | null;
  symbols?: string[];
  ivRank?: number | null;
  eventsBySymbol?: Record<
    string,
    { earningsInDays?: number | null; exDivInDays?: number | null }
  >;
}

export interface ResearchDiscoveryRunResult {
  success: boolean;
  proposals: DiscoveredGoalProposal[];
  /** Goals persisted (proposed-only) by this run. */
  persisted: number;
  limitations: string[];
  error?: string;
}

export interface ResearchRunSummary {
  runId: string;
  trigger: TriggerSource;
  userLogin: string;
  createdAt: string;
  rulesVersion: string;
  ideas: number;
  watchlist: number;
  rejected: number;
  summary: string;
}

export class ResearchAgent extends PortThink {
  /**
   * Issue #1953 (think-fleet, tracker #1951, shape (a)): Think behind
   * the existing actor port, via the foundation's PortThink — never
   * raw Think, and never a Think-signature beforeTurn/onChatResponse/
   * onChatError method on this class (PortThink's translation owns
   * those; see src/actors/thinkAdapter.ts). The model/tool identity
   * below is the port facet other actors and the MCP layer read;
   * live dispatch runs through direct methods (runResearch /
   * runDiscovery) and the SDK's runAgentTool, not a chat turn.
   * A turn, when one is driven, goes through the port adapter
   * (createThinkActorTurn): the adapter owns the lifecycle boot
   * (await lifecycle.start() before any turn — NEVER lifecycle
   * .ready?.(), which silently no-ops), calls the port's beforeTurn
   * exactly once via the one-shot override, and flushes
   * onChatResponse after appending, restoring runner order.
   * Direct domain methods below are NOT turns and take no boot.
   */
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // The class's port hooks object. Research is a non-chat actor:
    // the turn hooks are identity defaults — beforeTurn overrides
    // nothing (Think defaults apply), onChatResponse has no side
    // effect (the turn caller owns the result), and onChatError is
    // SYNCHRONOUS: Think fires it fire-and-forget, so only a sync
    // hook can control the error text (spike fact #1935). The raw
    // message is returned, matching Think's own fallback text.
    // Tree operations (branching, compaction, FTS) have NO port
    // equivalent and stay outside the port by design.
    this.portHooks = {
      getModel: () => this.getModel(),
      getSystemPrompt: () => this.getSystemPrompt(),
      getTools: () => this.getTools(),
      beforeTurn: async () => undefined,
      onChatResponse: async () => {},
      onChatError: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    } satisfies ActorTurnHooks;
  }
  getModel() {
    return resolveAiModelName(this.env, "researchAgent");
  }

  getSystemPrompt(): string {
    return "You are the read-only options research agent. For a research request, call run_options_research exactly once and then summarize its result faithfully. For a goal/scenario discovery request, call run_goal_discovery exactly once; discovered goals are proposals for human confirmation, never activated goals. You may discover, analyze, validate, and recommend strategies, but must never place, preview, or submit trades. Use only source-backed market data; report uncertainty and do not fabricate missing fields.";
  }

  getTools(): ToolSet {
    return {
      run_options_research: tool({
        description: "Run the validated, read-only options research pipeline and persist the resulting report.",
        inputSchema: z.object({
          trigger: z.enum(["manual", "scheduled"]),
          userLogin: z.string().optional(),
        }),
        execute: async (input) => {
          const result = await this.runResearch(input);
          return JSON.stringify({ success: result.success, error: result.error, runId: result.report?.runId, ideas: result.report?.ideas.length, summary: result.report?.summary });
        },
      }),
      run_goal_discovery: tool({
        description: "Run goal/scenario discovery (epic #1096 Phase 1 engine, Phase 3 run type): regime + event triggers over the research provider seam, persisting discovered goals as PROPOSED only. Portfolio triggers run only when the caller supplies portfolio state; on this tool path they are skipped and that limitation is reported.",
        inputSchema: z.object({
          trigger: z.enum(["manual", "scheduled"]),
          userLogin: z.string().optional(),
          symbols: z.array(z.string()).optional(),
          ivRank: z.number().nullable().optional(),
        }),
        execute: async (input) => {
          const result = await this.runDiscovery({
            trigger: input.trigger,
            userLogin: input.userLogin,
            symbols: input.symbols,
            ivRank: input.ivRank ?? null,
          });
          return JSON.stringify({ success: result.success, error: result.error, persisted: result.persisted, proposals: result.proposals.map((p) => ({ kind: p.kind, trigger: p.trigger })), limitations: result.limitations });
        },
      }),
    };
  }

  private researchPortsCache: ResearchStorePorts | null = null;

  /**
   * Issue #2361 (#1976 step 4e): this agent's private tables behind
   * the ResearchStore port family — the standard composition root
   * replaces the hand-rolled facade shim (and the dead DatabaseORM
   * construction that rode it; it had no callers). Composition
   * executes no DDL, and the family's ensureSchema creates ONLY
   * these agent-private tables: the shared ORM schema is never
   * touched from this class (the step-3a R-7 invariant, preserved
   * by construction and pinned in the 4e conformance suite).
   */
  private researchPorts(): ResearchStorePorts {
    if (!this.researchPortsCache) {
      this.researchPortsCache = createResearchStorePorts(this.ctx.storage.sql);
    }
    return this.researchPortsCache;
  }

  private ensureTables(): void {
    this.researchPorts().ensureSchema();
  }

  /** mas_settings-idiom store over this agent's research_settings table. */
  private settingsStore(): ResearchSettingsStore {
    return this.researchPorts().settings;
  }

  private configService(): ResearchConfigService {
    this.ensureTables();
    return new ResearchConfigService(this.settingsStore());
  }

  /** Issue #577: ledger store over this agent's research_task_store table. */
  private taskStore(): ResearchTaskStore {
    return this.researchPorts().tasks;
  }

  private taskLedger(): ResearchTaskLedger {
    this.ensureTables();
    return new ResearchTaskLedger(this.taskStore());
  }

  /**
   * Cloudflare Agents lifecycle: reconcile durable work left by a
   * prior incarnation (issue #2761, tracker #2708 A10). A fresh
   * incarnation has executed nothing, so every active task-ledger
   * record found at start belongs to a dead incarnation — that
   * incarnation's runs were interrupted mid-flight and their
   * records are recovered (marked interrupted) here, at first
   * touch, instead of waiting for the orchestrator's #618 stale
   * sweep to reach this instance. Recovery failure must never
   * break agent start — a throw out of onStart is terminal for
   * the instance — so it is logged, not propagated; the #618 sweep
   * remains the backstop for anything this pass misses.
   */
  override async onStart(): Promise<void> {
    try {
      const recovered = await this.recoverInterruptedResearchTasks();
      if (recovered.length > 0) {
        structuredLog.warn("researchAgent.on_start_recovery_interrupted", {
          message: `[ResearchAgent] Start-up recovery marked ${recovered.length} interrupted research task(s) as failed → escalated.`,
          recoveredCount: recovered.length,
        });
      }
    } catch (error) {
      structuredLog.error("researchAgent.on_start_recovery_failed", {
        message: "[ResearchAgent][onStart] Interrupted-run recovery failed:",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Issue #577 — durable task record for a delegated research run.
   * The orchestrator creates + begins a task before dispatch and
   * completes/fails it afterwards; the record lives with the work.
   */
  async createResearchTask(input: {
    trigger: "manual" | "scheduled";
    userLogin: string;
    idempotencyKey: string;
  }): Promise<{ task: ResearchTask; created: boolean }> {
    return this.taskLedger().create(input);
  }

  /** Claim + start a queued task (the coordinator begins the work). */
  async beginResearchTask(id: string): Promise<ResearchTask> {
    const ledger = this.taskLedger();
    ledger.claim(id);
    return ledger.start(id);
  }

  /** Issue #624: refresh a task's heartbeat during a long run. */
  async heartbeatResearchTask(id: string): Promise<ResearchTask> {
    return this.taskLedger().heartbeat(id);
  }

  async completeResearchTask(
    id: string,
    outcome: {
      path: ResearchExecutionPath;
      reportRunId: string;
      evaluation: ResearchTaskEvaluation;
    }
  ): Promise<ResearchTask> {
    return this.taskLedger().complete(id, outcome);
  }

  /** Fail a task; escalate=true leaves it in `escalated` for a human. */
  async failResearchTask(
    id: string,
    error: string,
    escalate: boolean
  ): Promise<ResearchTask> {
    const ledger = this.taskLedger();
    const failed = ledger.fail(id, error);
    return escalate ? ledger.escalate(id, "research run failed; awaiting human review") : failed;
  }

  async getResearchTask(id: string): Promise<ResearchTask | null> {
    return this.taskLedger().get(id);
  }

  async listResearchTasks(limit = 50): Promise<ResearchTask[]> {
    return this.taskLedger().list(limit);
  }

  /** Issue #615 (R4): active research tasks whose heartbeat aged out. */
  async findStaleResearchTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ResearchTask[]> {
    return this.taskLedger().findStale(staleAfterMs);
  }

  /** Issue #615 (R4): close stale research tasks as failed → escalated. */
  async sweepStaleResearchTasks(
    staleAfterMs: number = DEFAULT_STALE_AFTER_MS
  ): Promise<ResearchTask[]> {
    return this.taskLedger().sweepStale(staleAfterMs);
  }

  /**
   * Issue #2761 (tracker #2708 A10): close every active research
   * task as interrupted (failed → escalated, the interruption
   * recorded in the task's history). Invoked by onStart, where an
   * active record is orphaned by construction (see onStart); also
   * callable directly. Never auto-reruns a run — the run may have
   * partially happened, and persistRun may already have published
   * its report before the orchestrator could complete the task,
   * so re-dispatch would publish a second, divergent report for
   * one delegated run (#615 doctrine); retry as a NEW run belongs
   * to the caller/workflow layer. The ledger's idempotency slot
   * is deliberately respected in both directions: an active
   * record still dedupes a duplicate create, and once the record
   * is terminal a later create under the same key starts fresh —
   * recovery itself writes only through the ledger's guarded
   * transitions.
   */
  async recoverInterruptedResearchTasks(): Promise<ResearchTask[]> {
    return this.taskLedger().recoverInterrupted(
      "interrupted: agent restarted before the run completed (start-up recovery)"
    );
  }

  /** Issue #635: delete terminal task records past the retention tiers. */
  async pruneExpiredResearchTasks(): Promise<string[]> {
    return this.taskLedger().pruneExpired();
  }

  /** Typed config read (amendment 1: the single config owner). */
  async getResearchConfig(): Promise<ResearchConfig> {
    return this.configService().load();
  }

  /** Typed config write; invalid patches are rejected atomically. */
  async saveConfig(
    patch: Partial<ResearchConfig>
  ): Promise<{ config: ResearchConfig; errors: string[] }> {
    return this.configService().save(patch);
  }

  /**
   * Issue #2223 (final slice): A2A door, cfpay signature — the edge
   * dispatcher (src/a2a) resolves the "research" name to this class
   * on the service identity's research:<login> instance (fail-closed
   * when none is configured) and calls this with the parsed body +
   * origin (a Request cannot cross the DO RPC boundary). Thin
   * delegation to the dispatch module (./researchA2aDispatch),
   * which threads the service identity into run requests explicitly
   * — and since issue #2327 the run methods themselves refuse an
   * absent login, so no door can inherit a default identity.
   * Returns the collected { text, data } outcome.
   */
  async handleA2A(body: unknown, origin: string): Promise<ResearchA2AOutcome> {
    void origin; // reserved for per-origin policy (cfpay parity); unused in v1
    const data = await dispatchResearchA2A(this.env, body, {
      executor: {
        runResearch: (req) => this.runResearch(req),
        runDiscovery: (req) => this.runDiscovery(req),
        getLatest: () => this.getLatest(),
        getHistory: () => this.getHistory(),
        getTrackRecord: () => this.getTrackRecord(),
        evaluateRun: (runId, userLogin) => this.evaluateRun(runId, userLogin),
        getResearchConfig: () => this.getResearchConfig(),
      },
    });
    return researchA2AOutcome(data);
  }

  /**
   * THE pipeline entry for this agent. Runs the full OODA research loop
   * and persists the run record. Publication (canonical store) is the
   * orchestrator's job — see runResearchAndPublish.
   */
  async runResearch(req: ResearchRunRequest): Promise<ResearchRunResult> {
    // Issue #2327: no identity, no run — a request that cannot name
    // its actor is refused, never executed under a default login.
    const userLogin = explicitResearchLogin(req.userLogin);
    if (!userLogin) {
      return { success: false, report: null, error: RESEARCH_IDENTITY_REQUIRED };
    }
    try {
      this.ensureTables();
      const service = this.configService();
      let config = service.load();
      if (req.configOverride) {
        const merged = service.save(req.configOverride);
        if (merged.errors.length > 0) {
          return {
            success: false,
            report: null,
            error: `Invalid config override: ${merged.errors.join("; ")}`,
          };
        }
        config = merged.config;
      }
      // Issue #1331: history resolution degrades to undefined deps
      // (honestly-null technicals) instead of failing the run — the
      // old yahooHistory contract. See resolveYahooHistoryDeps.
      const historyDeps = await resolveYahooHistoryDeps({
        sql: this.ctx.storage.sql,
        env: this.env,
        userLogin,
        blobStorage: this.ctx.storage,
        runId: crypto.randomUUID(),
      });
      // Issue #1378: universe deps, bound the same way as
      // historyDeps above (route-resolved + capture; a bundle
      // failure degrades to undefined, and listings() then
      // degrades to empty — never a direct fetch). Decision D2:
      // captures use a generated run id (research has no caller
      // run id).
      let universeDeps: NasdaqUniverseDeps | undefined;
      try {
        const universeBundle = await nasdaqUniverseRouteBundle({
          sql: this.ctx.storage.sql,
          storage: this.ctx.storage,
          env: this.env,
          userLogin: userLogin,
          runId: crypto.randomUUID(),
        });
        const universeProvider = nasdaqUniverseProviderFromRoute(
          universeBundle.registry,
          universeBundle.configs,
          universeBundle.routes
        );
        universeDeps = bindNasdaqUniverseDeps(universeProvider, universeBundle.runContext);
      } catch (err) {
        structuredLog.warn("researchAgent.run_research_universe_deps_unavailable", {
          message: `[research-agent] universe deps unavailable, listings degrade to empty: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const provider = new EtradeResearchDataProvider(
        this.env,
        userLogin,
        historyDeps,
        universeDeps
      );
      // Issue #773: feed historical evaluation outcomes into the pipeline's Decide stage.
      let trackRecord: import("../services/researchTrackRecord").TrackRecord | undefined;
      try {
        trackRecord = await this.getTrackRecord();
      } catch {
        // No track record yet — pipeline runs without feedback.
      }
      const report = await runResearchPipeline(
        { provider, ...(trackRecord ? { trackRecord } : {}) },
        config,
        { trigger: req.trigger, userLogin }
      );
      await this.persistRun(report);
      return { success: true, report };
    } catch (err) {
      return {
        success: false,
        report: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Issue #1122 (epic #1096 Phase 3): the discovery RUN TYPE. Runs the
   * Phase 1 goal/scenario discovery engine over this agent's provider
   * seam (the same EtradeResearchDataProvider as runResearch — one
   * pipeline, discovery is a mode of it) and persists every proposal
   * through persistDiscoveredGoals: source "discovered", status
   * "proposed", tenant-scoped. There is deliberately no activation
   * path — a discovered goal becomes active only by a separate human
   * decision outside this agent.
   */
  async runDiscovery(
    req: ResearchDiscoveryRunRequest
  ): Promise<ResearchDiscoveryRunResult> {
    // Issue #2327: same discipline as runResearch — no identity, no run.
    const userLogin = explicitResearchLogin(req.userLogin);
    if (!userLogin) {
      return {
        success: false,
        proposals: [],
        persisted: 0,
        limitations: [],
        error: RESEARCH_IDENTITY_REQUIRED,
      };
    }
    try {
      this.ensureTables();
      // Issue #1331: history resolution degrades to undefined deps
      // (honestly-null technicals) instead of failing the run — the
      // old yahooHistory contract. See resolveYahooHistoryDeps.
      const historyDeps = await resolveYahooHistoryDeps({
        sql: this.ctx.storage.sql,
        env: this.env,
        userLogin,
        blobStorage: this.ctx.storage,
        runId: crypto.randomUUID(),
      });
      // Issue #1378: universe deps, bound the same way as
      // historyDeps above (route-resolved + capture; a bundle
      // failure degrades to undefined, and listings() then
      // degrades to empty — never a direct fetch). Decision D2:
      // captures use a generated run id (research has no caller
      // run id).
      let universeDeps: NasdaqUniverseDeps | undefined;
      try {
        const universeBundle = await nasdaqUniverseRouteBundle({
          sql: this.ctx.storage.sql,
          storage: this.ctx.storage,
          env: this.env,
          userLogin: userLogin,
          runId: crypto.randomUUID(),
        });
        const universeProvider = nasdaqUniverseProviderFromRoute(
          universeBundle.registry,
          universeBundle.configs,
          universeBundle.routes
        );
        universeDeps = bindNasdaqUniverseDeps(universeProvider, universeBundle.runContext);
      } catch (err) {
        structuredLog.warn("researchAgent.run_discovery_universe_deps_unavailable", {
          message: `[research-agent] universe deps unavailable, listings degrade to empty: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const provider = new EtradeResearchDataProvider(
        this.env,
        userLogin,
        historyDeps,
        universeDeps
      );
      const out = await runGoalScenarioDiscovery({
        provider,
        portfolio: req.portfolio ?? null,
        symbols: req.symbols ?? [],
        ivRank: req.ivRank ?? null,
        eventsBySymbol: req.eventsBySymbol,
      });
      const created = persistDiscoveredGoals(
        this.ctx.storage.sql,
        userLogin,
        out.proposals
      );
      return {
        success: true,
        proposals: out.proposals,
        persisted: created.length,
        limitations: out.limitations,
      };
    } catch (err) {
      return {
        success: false,
        proposals: [],
        persisted: 0,
        limitations: [],
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Scheduled discovery: guard-gated by the #354 idiom (weekday,
   * ≥21:00 UTC, durable agent-local marker in research_settings), so
   * the orchestrator's every-30-minutes scheduled tick can invoke it after the
   * scheduled research run without any new cron trigger. The marker
   * is written only after a successful run, so a failed night
   * retries on the next tick. Portfolio state is not supplied on
   * this path — portfolio triggers skip with their limitation
   * recorded by the engine.
   */
  async runDiscoveryIfDue(
    now: Date,
    req: Omit<ResearchDiscoveryRunRequest, "trigger">
  ): Promise<{ fired: boolean; dateKey: string; result?: ResearchDiscoveryRunResult }> {
    const store = this.settingsStore();
    const decision = shouldFireResearchTick(
      now,
      store.get(RESEARCH_DISCOVERY_LAST_RUN_KEY)
    );
    if (!decision.fire) return { fired: false, dateKey: decision.dateKey };
    const result = await this.runDiscovery({ ...req, trigger: "scheduled" });
    if (result.success) {
      store.set(RESEARCH_DISCOVERY_LAST_RUN_KEY, researchTickDateKey(now));
    }
    return { fired: true, dateKey: decision.dateKey, result };
  }

  async getLatest(): Promise<ResearchReport | null> {
    try {
      return (await this.ctx.storage.get<ResearchReport>(LATEST_KEY)) ?? null;
    } catch {
      return null;
    }
  }

  /**
   * #335: store the run's PDF (delivery artifact, rendered from the canonical
   * stored report). Per-run key + latest pointer, mirroring the screener PDF
   * pattern (#361). #605: blobs go to R2 when bound, else legacy DO storage.
   * Best-effort — never throws.
   */
  async storeResearchPdf(
    fileName: string,
    bytes: Uint8Array
  ): Promise<string | null> {
    try {
      const { putReportPdf } = await import("../services/reportBlobStore");
      const perRunKey = `${RESEARCH_PDF_KEY_PREFIX}${fileName}`;
      await putReportPdf(this.env, this.ctx.storage, perRunKey, fileName, bytes);
      await putReportPdf(this.env, this.ctx.storage, RESEARCH_PDF_LATEST_KEY, fileName, bytes);
      return perRunKey;
    } catch (err) {
      structuredLog.warn("researchAgent.store_research_pdf_failed", {
        message: "[ResearchAgent] PDF store failed:",
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /**
   * #335: fetch a stored research PDF by key (or "latest").
   * #605: reads from R2 when bound, else legacy DO storage.
   */
  async getResearchPdfByKey(
    pdfKey: string
  ): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    try {
      const { getReportPdf } = await import("../services/reportBlobStore");
      const key = pdfKey === "latest" ? RESEARCH_PDF_LATEST_KEY : pdfKey;
      return await getReportPdf(this.env, this.ctx.storage, key);
    } catch {
      return null;
    }
  }

  /**
   * Issue #2167: generate + store the research run's workbook and CSV —
   * the research twin of ScreenerAgent.generateAndStoreStrategyReport.
   *
   * Keys mirror the PDF's `report:pdf:research:<id>` family, so one run's
   * artifacts sit together in storage. Each format has its own failure
   * domain (#1278): a failed leg is recorded, never fatal.
   */
  async generateAndStoreResearchArtifacts(
    report: import("../services/researchPipeline").ResearchReport,
  ): Promise<import("../trading").ResearchWorkbookOutcome> {
    const { withRetry } = await import("../services/resilience");
    const { resolvePipelinePolicy } = await import("../services/pipelinePolicy");
    const { putReportPdf } = await import("../services/reportBlobStore");
    const { generateResearchReportXlsx, generateResearchReportCsv, researchReportFileName } = await import(
      "../trading"
    );
    const policy = resolvePipelinePolicy(this.env as unknown as Record<string, unknown>).retry.report;
    const id = crypto.randomUUID().slice(0, 8);
    const outcome: import("../trading").ResearchWorkbookOutcome = {
      xlsxStatus: "failed",
      csvStatus: "failed",
    };

    try {
      const key = `report:xlsx:research:${id}`;
      const bytes = generateResearchReportXlsx(report);
      await withRetry(
        () =>
          putReportPdf(
            this.env,
            this.ctx.storage,
            key,
            researchReportFileName(report, "xlsx"),
            bytes,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          ),
        policy,
        { label: "research-xlsx" },
      );
      outcome.xlsxKey = key;
      outcome.xlsxStatus = "generated";
    } catch (err) {
      outcome.xlsxError = codedMessage("FAILURE_REPORT_XLSX_GENERATION", err instanceof Error ? err.message : String(err));
      structuredLog.error("researchAgent.generate_and_store_research_artifacts_xlsx_generation_failed", {
        message: "[ResearchAgent] Research XLSX generation failed:",
        error: outcome.xlsxError,
      });
    }

    try {
      const key = `report:csv:research:${id}`;
      const bytes = new TextEncoder().encode(generateResearchReportCsv(report));
      await withRetry(
        () =>
          putReportPdf(
            this.env,
            this.ctx.storage,
            key,
            researchReportFileName(report, "csv"),
            bytes,
            "text/csv",
          ),
        policy,
        { label: "research-csv" },
      );
      outcome.csvKey = key;
      outcome.csvStatus = "generated";
    } catch (err) {
      outcome.csvError = codedMessage("FAILURE_REPORT_CSV_GENERATION", err instanceof Error ? err.message : String(err));
      structuredLog.error("researchAgent.generate_and_store_research_artifacts_csv_generation_failed", {
        message: "[ResearchAgent] Research CSV generation failed:",
        error: outcome.csvError,
      });
    }

    return outcome;
  }

  /** Issue #2167: serve a stored research workbook by key. */
  async getResearchXlsxByKey(
    key: string
  ): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    try {
      const { getReportPdf } = await import("../services/reportBlobStore");
      return await getReportPdf(this.env, this.ctx.storage, key);
    } catch {
      return null;
    }
  }

  /** Issue #2167: serve a stored research CSV by key. */
  async getResearchCsvByKey(
    key: string
  ): Promise<{ bytes: Uint8Array; fileName: string } | null> {
    try {
      const { getReportPdf } = await import("../services/reportBlobStore");
      return await getReportPdf(this.env, this.ctx.storage, key);
    } catch {
      return null;
    }
  }

  /**
   * #336: pre-entry refresh. Re-fetch live quotes for the shortlisted ideas
   * and flag any that moved materially or went stale since the run. Returns
   * one flag per affected idea; empty means "no change". Best-effort — never
   * throws; a provider failure yields no flags, not a failed delivery.
   */
  async refreshIdeaQuotes(
    report: ResearchReport,
    userLogin?: string
  ): Promise<
    Array<{ symbol: string; status: "moved" | "stale"; detail: string }>
  > {
    const flags: Array<{
      symbol: string;
      status: "moved" | "stale";
      detail: string;
    }> = [];
    // Issue #2327: the refresh reads under the caller's login or the
    // report's recorded owner — with neither, there is no identity to
    // attribute the provider reads to, so no refresh runs (no flags
    // is this method's honest degradation, never a default login).
    const login =
      explicitResearchLogin(userLogin) ?? explicitResearchLogin(report.userLogin);
    if (!login) {
      structuredLog.warn("researchAgent.refresh_idea_quotes_pre_entry_refresh_skipped", {
        message: "[ResearchAgent] Pre-entry refresh skipped: no explicit userLogin and the report records no owner.",
      });
      return flags;
    }
    try {
      // Issue #1331: history resolution degrades to undefined deps
      // (honestly-null technicals) instead of failing the quote
      // refresh — the old yahooHistory contract. A history outage
      // must never zero the quote flags this method exists to raise.
      // See resolveYahooHistoryDeps.
      const historyDeps = await resolveYahooHistoryDeps({
        sql: this.ctx.storage.sql,
        env: this.env,
        userLogin: login,
        blobStorage: this.ctx.storage,
        runId: crypto.randomUUID(),
      });
      // Issue #1378: universe deps, bound the same way as
      // historyDeps above (route-resolved + capture; a bundle
      // failure degrades to undefined, and listings() then
      // degrades to empty — never a direct fetch). Decision D2:
      // captures use a generated run id (research has no caller
      // run id).
      let universeDeps: NasdaqUniverseDeps | undefined;
      try {
        const universeBundle = await nasdaqUniverseRouteBundle({
          sql: this.ctx.storage.sql,
          storage: this.ctx.storage,
          env: this.env,
          userLogin: login,
          runId: crypto.randomUUID(),
        });
        const universeProvider = nasdaqUniverseProviderFromRoute(
          universeBundle.registry,
          universeBundle.configs,
          universeBundle.routes
        );
        universeDeps = bindNasdaqUniverseDeps(universeProvider, universeBundle.runContext);
      } catch (err) {
        structuredLog.warn("researchAgent.refresh_idea_quotes_universe_deps_unavailable", {
          message: `[research-agent] universe deps unavailable, listings degrade to empty: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const provider = new EtradeResearchDataProvider(
        this.env,
        login,
        historyDeps,
        universeDeps
      );
      for (const idea of (report.ideas ?? []).slice(0, 5)) {
        let quote: { price?: number | null } | null = null;
        try {
          quote = await provider.getQuote(idea.symbol);
        } catch {
          quote = null;
        }
        if (!quote || quote.price == null || !Number.isFinite(quote.price)) {
          flags.push({
            symbol: idea.symbol,
            status: "stale",
            detail: "No live quote at delivery time — entry price unverified.",
          });
          continue;
        }
        const entry = idea.entrySpot;
        if (entry > 0) {
          const movePct = ((quote.price - entry) / entry) * 100;
          if (Math.abs(movePct) >= 2) {
            flags.push({
              symbol: idea.symbol,
              status: "moved",
              detail: `Underlying moved ${movePct >= 0 ? "+" : ""}${movePct.toFixed(2)}% since entry reference $${entry.toFixed(2)} (now $${quote.price.toFixed(2)}).`,
            });
          }
        }
      }
    } catch (err) {
      structuredLog.warn("researchAgent.refresh_idea_quotes_pre_entry_refresh_failed", {
        message: "[ResearchAgent] Pre-entry refresh failed:",
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return flags;
  }

  async getHistory(): Promise<ResearchRunSummary[]> {
    try {
      return (await this.ctx.storage.get<ResearchRunSummary[]>(HISTORY_KEY)) ?? [];
    } catch {
      return [];
    }
  }

  /**
   * Issue #340: the track record — every published run's ideas joined
   * to their latest §9 evaluations. Read-only over the stored rows;
   * never throws (an empty record on any failure).
   */
  async getTrackRecord(): Promise<import("../services/researchTrackRecord").TrackRecord> {
    const { buildTrackRecord } = await import("../services/researchTrackRecord");
    try {
      this.ensureTables();
      const ports = this.researchPorts();
      const parse = (v: unknown): unknown => {
        if (typeof v !== "string") return null;
        try {
          return JSON.parse(v);
        } catch {
          return null;
        }
      };
      return buildTrackRecord(
        ports.runs.listReportJsonValues().map(parse),
        ports.evaluations.listEvaluationJsonValues().map(parse)
      );
    } catch {
      return buildTrackRecord([], []);
    }
  }

  /**
   * §9 evaluation pass: compare a published run's ideas against later
   * prices. Reads the stored run; writes an evaluation row; never mutates
   * the original report.
   */
  async evaluateRun(runId: string, userLogin?: string): Promise<ResearchEvaluation | null> {
    try {
      this.ensureTables();
      const raw = this.researchPorts().runs.getReportJsonValue(runId);
      if (typeof raw !== "string") return null;
      const report = JSON.parse(raw) as ResearchReport;
      // Issue #2327: the evaluation is attributed to the caller when
      // it names one, else to the run's recorded owner — never to a
      // default identity. With neither, decline (null, this method's
      // failure value) before any provider work happens.
      const login =
        explicitResearchLogin(userLogin) ?? explicitResearchLogin(report.userLogin);
      if (!login) return null;
      const ideas: StoredIdeaRecord[] = report.ideas.map((idea) => ({
        runId: report.runId,
        symbol: idea.symbol,
        structure: idea.structure,
        legs: idea.legs,
        economics: idea.economics,
        thesis: idea.thesis,
        invalidation: idea.invalidation,
        entrySpot: idea.entrySpot,
        quoteTimestamp: idea.quoteTimestamp,
        rulesVersion: report.rulesVersion,
        createdAt: report.createdAt,
        outlook: (idea as { outlook?: StoredIdeaRecord["outlook"] }).outlook,
      }));
      // Issue #1331: history resolution degrades to undefined deps
      // (honestly-null technicals) instead of failing the run — the
      // old yahooHistory contract. See resolveYahooHistoryDeps.
      const historyDeps = await resolveYahooHistoryDeps({
        sql: this.ctx.storage.sql,
        env: this.env,
        userLogin: login,
        blobStorage: this.ctx.storage,
        runId: crypto.randomUUID(),
      });
      // Issue #1378: universe deps, bound the same way as
      // historyDeps above (route-resolved + capture; a bundle
      // failure degrades to undefined, and listings() then
      // degrades to empty — never a direct fetch). Decision D2:
      // captures use a generated run id (research has no caller
      // run id).
      let universeDeps: NasdaqUniverseDeps | undefined;
      try {
        const universeBundle = await nasdaqUniverseRouteBundle({
          sql: this.ctx.storage.sql,
          storage: this.ctx.storage,
          env: this.env,
          userLogin: login,
          runId: crypto.randomUUID(),
        });
        const universeProvider = nasdaqUniverseProviderFromRoute(
          universeBundle.registry,
          universeBundle.configs,
          universeBundle.routes
        );
        universeDeps = bindNasdaqUniverseDeps(universeProvider, universeBundle.runContext);
      } catch (err) {
        structuredLog.warn("researchAgent.evaluate_run_universe_deps_unavailable", {
          message: `[research-agent] universe deps unavailable, listings degrade to empty: ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      const provider = new EtradeResearchDataProvider(
        this.env,
        login,
        historyDeps,
        universeDeps
      );
      const config = this.configService().load();
      const evaluation = await runResearchEvaluation(
        { provider },
        ideas,
        runId,
        config
      );
      const id = `eval_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
      this.researchPorts().evaluations.insertEvaluation({
        id,
        runId,
        evaluatedAt: evaluation.evaluatedAt,
        evaluationJson: JSON.stringify(evaluation),
      });
      // #584 EP-009: meter the evaluation — attributed to tenant + task.
      try {
        const { recordUsageEvent } = await import(
          "../services/scheduledReports"
        );
        recordUsageEvent(this.ctx.storage.sql, {
          userLogin: login,
          runId,
          category: "research_evaluation",
          detail: { ideas: evaluation.ideas.length },
        });
      } catch {
        // Metering is advisory.
      }
      // Issue #1742: best-effort thesis-realization projection —
      // scored ideas from this evaluation land in D1 telemetry
      // (idempotent by outcome id). Failure-isolated in its own
      // try/catch: a projection failure is warned, never fails
      // evaluateRun (calibration never blocks a thesis run).
      // Unbound AgentDB skips silently, exactly as before.
      // Covers both callers (manual /research/evaluate and the
      // due-runs pass) because both flow through evaluateRun.
      try {
        const agentDb = (this.env as unknown as { AGENT_DB?: unknown }).AGENT_DB;
        if (agentDb) {
          const { createTelemetryAdapter, ensureTelemetryTables } =
            await import("../telemetry/createTelemetryPorts");
          const { resolveIaaaTenant } = await import(
            "../security/iaaaGithubEndToEnd"
          );
          const adapter = createTelemetryAdapter({ AGENT_DB: agentDb });
          if (adapter) {
            await ensureTelemetryTables(adapter);
            const { reportRegime } = await import(
              "../services/researchTrackRecord"
            );
            const { projectEvaluationRealizations } = await import(
              "../telemetry/telemetryProjection"
            );
            // Issue #1743: realization_recorded envelopes flow
            // to the observability stream (best-effort, inside
            // this block's try/catch — the stream never blocks
            // evaluateRun, and unbound degrades to local logs).
            const { createObservabilitySink } = await import(
              "../observability/createObservabilityPorts"
            );
            const { writeEnvelopeToSink } = await import(
              "../observability/observabilityPorts"
            );
            const observabilitySink = createObservabilitySink(this.env);
            await projectEvaluationRealizations(
              adapter,
              {
                runId: report.runId,
                regime: reportRegime(report.regime),
                ideas: report.ideas,
              },
              evaluation,
              resolveIaaaTenant(this.env),
              undefined,
              {
                emit: (envelope) => {
                  void writeEnvelopeToSink(observabilitySink, envelope);
                },
              },
            );
          }
        }
      } catch (err) {
        structuredLog.warn("researchAgent.evaluate_due_runs_telemetry_projection_failed", {
          message: `[telemetry] realization projection failed (ignored): ${err instanceof Error ? err.message : String(err)}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      return evaluation;
    } catch {
      return null;
    }
  }

  /**
   * #583 docx §9: evaluate runs due for follow-up — runs older than
   * `minAgeMs` with no evaluation row yet (oldest first, capped).
   * Best-effort: per-run failures are recorded as nulls, never thrown.
   */
  async evaluateDueRuns(
    userLogin?: string,
    minAgeMs = 24 * 3600 * 1000,
    nowMs = Date.now(),
    limit = 5
  ): Promise<{ evaluated: string[]; failed: string[] }> {
    const evaluated: string[] = [];
    const failed: string[] = [];
    try {
      this.ensureTables();
      const ports = this.researchPorts();
      const runs = ports.runs.listRunRefs();
      const evaluatedIds = new Set(
        ports.evaluations
          .listEvaluatedRunIds()
          .filter((id): id is string => typeof id === "string")
      );
      const { selectRunsDueForEvaluation } = await import(
        "../services/researchPipeline"
      );
      const due = selectRunsDueForEvaluation(
        runs
          .filter(
            (r): r is { runId: string; createdAt: string } =>
              typeof r.runId === "string" && typeof r.createdAt === "string"
          )
          .map((r) => ({ runId: r.runId, createdAt: r.createdAt })),
        evaluatedIds,
        nowMs,
        minAgeMs,
        limit
      );
      for (const runId of due) {
        const res = await this.evaluateRun(runId, userLogin);
        (res ? evaluated : failed).push(runId);
      }
    } catch {
      // Best-effort: a scheduling pass must never break the tick.
    }
    return { evaluated, failed };
  }

  private async persistRun(report: ResearchReport): Promise<void> {
    try {
      await this.ctx.storage.put(LATEST_KEY, report);
      const history = await this.getHistory();
      history.unshift({
        runId: report.runId,
        trigger: report.trigger,
        userLogin: report.userLogin,
        createdAt: report.createdAt,
        rulesVersion: report.rulesVersion,
        ideas: report.ideas.length,
        watchlist: report.watchlist.length,
        rejected: report.rejected.length,
        summary: report.summary,
      });
      await this.ctx.storage.put(HISTORY_KEY, history.slice(0, MAX_HISTORY));

      this.researchPorts().runs.replaceRun({
        runId: report.runId,
        trigger: report.trigger,
        userLogin: report.userLogin,
        createdAt: report.createdAt,
        rulesVersion: report.rulesVersion,
        status: report.ideas.length > 0 ? "published" : "no_qualifying",
        ideasCount: report.ideas.length,
        reportJson: JSON.stringify(report),
      });
    } catch {
      // Non-critical: a persistence failure must not fail the run itself.
    }
  }
}

/** Re-exported for the boundary test's module inventory. */
export const RESEARCH_AGENT_TABLES = [
  "research_settings",
  "research_runs",
  "research_evaluations",
] as const;

export const RESEARCH_DEFAULTS = RESEARCH_CONFIG_DEFAULTS;
