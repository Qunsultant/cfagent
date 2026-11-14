/**
 * Issue #3186 step 3b - production ports for the options pipeline:
 * the eight stage ports over the REAL engines. The composer stays
 * thin; every stage wraps the function the live path already uses.
 *
 *   plan       plannerPort (Phase A options plan Block)
 *   chainFetch DynamicOptionsScreener.fetchChains (step 3a extraction)
 *   enrich     evaluateContracts (step 3a extraction)
 *   screen     aggregateScreenResult (step 3a extraction) + the
 *              #1963 result-status rule (nothing fetched -> throw)
 *   risk       assessSagaTradeRisk (#3000 shape; no intent -> the
 *              engine's own unassessed, never blocks)
 *   persistCanonicalResults  recordUnifiedOptionsRun (mas_reports -
 *              the plain screen's canonical store; see the correction
 *              in tests/options_screen_ports_3186.test.ts)
 *   shapeReport / deliver  caller-supplied (goal leg vs route
 *              delivery differ; the port interface is uniform)
 *
 * Checkpoint artifacts live in DO storage under
 * `options:<runId>:<stageId>` (the stock pipeline's artifact
 * discipline: the artifact is persisted before its boundary
 * publishes). A stage loads its input by artifact key; the filter
 * rides the run's persisted input (PlannerInput.classInput - the
 * plan stage already validated it, the chainFetch stage re-parses
 * it with the route's parser, parseOptionsScreenRequest).
 *
 * Canonical-write discipline (the route's own): the canonical write
 * never fails the run - recordUnifiedOptionsRun returns null when
 * the ORM is absent, and the stage records created:false. A retry
 * re-records the same runId and gets created:false (idempotent).
 */
import type { ETradeOptionChain, OptionScreenFetchError, OptionScreenerFilter } from "../types";
import type { OptionsCanonicalStore, UnifiedOptionsRunRecord } from "../services/optionsServeRecord";
import { recordUnifiedOptionsRun } from "../services/optionsServeRecord";
import type { CanonicalReportStoreSeam } from "../services/generateJobs";
import {
  OPTIONS_CANONICAL_LEG_REASONS,
  recordUnifiedOptionsRunThroughLeg,
  type OptionsCanonicalLegReport,
} from "./optionsCanonicalLeg";
import type { SagaTradeIntent } from "./sagaTradeLeg";
import { assessSagaTradeRisk, type SagaRiskLimits } from "./sagaRiskStage";
// Issue #4066: these values come from the trading barrel
// (src/trading/index.ts), the sole public import surface under the
// #290 boundary — leaf imports of trading internals trip the
// boundary test.
import {
  aggregateScreenResult,
  DynamicOptionsScreener,
  evaluateContracts,
  parseOptionsScreenRequest,
} from "../trading";
import {
  createPlannerPort,
  optionsPlanBlock,
  type PlannerInput,
  type PlannerPort,
} from "./blocks/plannerPort";
import type {
  OptionsStageInput,
  OptionsStagePort,
} from "./optionsScreenWorkflow";
import type { OptionsPipelineStage } from "./stageRuntimeIds";

export function optionsArtifactKey(runId: string, stageId: string): string {
  return `options:${runId}:${stageId}`;
}

/** DO-storage-shaped checkpoint store (ctx.storage in production). */
export interface OptionsStageStorage {
  put(key: string, value: unknown): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
}

export interface OptionsShapeReportFn {
  (input: {
    runId: string;
    userLogin: string;
    request: OptionsPipelineRequest;
    canonical: { reportId: string | null; created: boolean; record: UnifiedOptionsRunRecord };
    /** The screen stage's output ({terminal, result}) - the report is built from the screen result, not from the canonical record alone. */
    screen: unknown;
  }): Promise<unknown>;
}

export interface OptionsDeliverFn {
  (input: {
    runId: string;
    userLogin: string;
    request: OptionsPipelineRequest;
    report: unknown;
  }): Promise<unknown>;
}

export interface OptionsScreenPortDeps {
  screener: DynamicOptionsScreener;
  planner?: PlannerPort;
  storage: OptionsStageStorage;
  /**
   * The canonical store the persist stage writes through. Optional:
   * a leg inside a composed run omits it — the leg builds its
   * canonical record in-memory (the shapeReport artifact carries it)
   * and writes NO mas_reports row; the composing run's row is the
   * single canonical home (the goal leg omits it for exactly this
   * reason — the agent's own store is a different SQLite from the
   * goal run's, so writing there would be a second home, #783).
   * Absent, the persist stage records created:false / reportId:null.
   *
   * Legacy direct path, kept during migration (#4060): the manual
   * entry now binds canonicalLeg instead, so no production caller
   * passes this after #4060 — it stays for entries not yet on the
   * leg. When both are bound the leg wins and this store is never
   * called (one row, one transport).
   */
  canonical?: OptionsCanonicalStore;
  /**
   * The engine's tenant-aware canonical leg (#4060, #3940): when
   * bound, the persist stage writes through it — the orchestrator
   * door into the report-owning tenant's Orchestrator DO — instead
   * of the direct store. The leg wins over `canonical` when both
   * are bound. Absent with no `canonical`, the stage records the
   * goal leg's honest omission (created:false, no mas_reports row)
   * with its coded reason — never a silent skip.
   */
  canonicalLeg?: CanonicalReportStoreSeam;
  shapeReport: OptionsShapeReportFn;
  deliver: OptionsDeliverFn;
  /**
   * Demo-mode calibrated-chains fallback (#65): when the live screen
   * matches nothing and this is on, generated chains substitute for
   * the empty live screen (stamped dataSource "calibrated-demo").
   * Production is live-only - off by default, the manual entry
   * passes the gate. Lives in the screen port (not the caller) so
   * the canonical row's summary reflects the fallback result.
   */
  demoFallback?: boolean;
  /**
   * The canonical record builder. Default builds the generic leg
   * record (title "Options screen", source "options-screen-workflow").
   * An entry whose canonical row has a pinned shape (the manual
   * route's "Options contract screen — <symbols>" /
   * "options_scanner" row) supplies its own builder; the shapeReport
   * re-record then backfills only the report keys + filter/result.
   */
  record?: (input: {
    runId: string;
    userLogin: string;
    request: OptionsPipelineRequest;
    screen: { terminal: string; result: Record<string, unknown> };
  }) => Promise<UnifiedOptionsRunRecord> | UnifiedOptionsRunRecord;
}

/** The run's persisted input: a PlannerInput whose classInput carries the options request. */
export interface OptionsPipelineRequest extends PlannerInput {
  classInput: {
    request?: { filter?: unknown; pushToSlack?: boolean; slackChannel?: string; universe?: string; emailTo?: string };
    goalPlan?: { optionsFilter?: unknown; structures?: string[]; goalId?: string; goalRunId?: string };
    tradeIntent?: SagaTradeIntent;
    riskLimits?: SagaRiskLimits;
    goalId?: string;
  };
}

/**
 * The plain ports' canonical record, report and delivery are
 * owner-scoped: they refuse to run without a real identity rather
 * than recording under an empty or invented login. (The scanner
 * ports keep the pinned unscoped-run discipline instead - see
 * strategyScreenPorts.ts - so this guard lives here, not in the
 * shared composer.) The goal leg and the manual entry always carry
 * a login, so this never fires in production; it is the type-level
 * proof that the plain path cannot silently go unscoped.
 */
function requireLogin(input: OptionsStageInput): string {
  if (!input.userLogin) {
    throw new Error("options screen ports: a real userLogin is required (the canonical record, report and delivery are owner-scoped)");
  }
  return input.userLogin;
}

function asRequest(input: OptionsStageInput): OptionsPipelineRequest {
  const request = input.request as OptionsPipelineRequest | null;
  if (!request || typeof request !== "object" || request.assetClass !== "options") {
    throw new Error(`options workflow: stage ${input.stageId} needs an options PlannerInput request`);
  }
  return request;
}

function readFilter(request: OptionsPipelineRequest): OptionScreenerFilter {
  const raw = request.classInput?.request?.filter ?? request.classInput?.goalPlan?.optionsFilter;
  if (raw === undefined) {
    throw new Error("options workflow: no options filter in the run request");
  }
  const parsed = parseOptionsScreenRequest({ ...(raw as Record<string, unknown>) });
  if (!parsed.ok) {
    throw new Error(`options workflow: invalid filter: ${JSON.stringify(parsed.error)}`);
  }
  return parsed.value.filter;
}

async function loadArtifact<T>(
  storage: OptionsStageStorage,
  input: OptionsStageInput,
  stageId: string,
): Promise<T> {
  // Always the deterministic checkpoint key, never artifactKeys[0]:
  // a stage that needs an EARLIER stage's artifact (the screen stage
  // needs chainFetch AND enrich) cannot load it from the previous
  // stage's key. The composer's artifactKeys ride the stage message;
  // the load mechanism is the run's namespaced checkpoint key.
  const key = optionsArtifactKey(input.runId, stageId);
  const value = await storage.get<T>(key);
  if (value === undefined) {
    throw new Error(`${stageId} artifact missing for run ${input.runId} (${key}); refusing to run a stage on input that was never persisted.`);
  }
  return value;
}

function readOutputTerminal(output: unknown): string | undefined {
  if (output && typeof output === "object") {
    const terminal = (output as { terminal?: unknown }).terminal;
    if (typeof terminal === "string") return terminal;
  }
  return undefined;
}

export function createOptionsScreenPorts(
  deps: OptionsScreenPortDeps,
): Record<OptionsPipelineStage, OptionsStagePort> {
  const planner = deps.planner ?? createPlannerPort([optionsPlanBlock()]);
  const { screener, storage, canonical } = deps;

  const persist = async (
    input: OptionsStageInput,
    output: unknown,
  ): Promise<string[]> => {
    const key = optionsArtifactKey(input.runId, input.stageId);
    await storage.put(key, output);
    return [key];
  };

  return {
    plan: {
      execute: async (input) => {
        const request = asRequest(input);
        const plan = planner.plan(request);
        return { terminal: "completed", plan };
      },
      persist: (input, output) => persist(input, output),
    },
    chainFetch: {
      execute: async (input) => {
        const request = asRequest(input);
        await loadArtifact(storage, input, "plan");
        const filter = readFilter(request);
        const fetched = await screener.fetchChains(filter);
        const terminal =
          fetched.fetchErrors.length > 0 || fetched.deferredSymbols.length > 0
            ? "partial"
            : "completed";
        return { terminal, ...fetched };
      },
      persist: (input, output) => persist(input, output),
    },
    enrich: {
      execute: async (input) => {
        const request = asRequest(input);
        const fetched = await loadArtifact<{
          chains: Array<{ symbol: string; chain: ETradeOptionChain }>;
          filter: OptionScreenerFilter;
          fetchErrors: OptionScreenFetchError[];
          deferredSymbols: string[];
        }>(storage, input, "chainFetch");
        const outcomes = evaluateContracts(
          fetched.chains,
          fetched.filter,
          screener.config,
        );
        const terminal =
          fetched.fetchErrors.length > 0 || fetched.deferredSymbols.length > 0
            ? "partial"
            : "completed";
        return { terminal, outcomes };
      },
      persist: (input, output) => persist(input, output),
    },
    screen: {
      execute: async (input) => {
        const fetched = await loadArtifact<{
          chains: Array<{ symbol: string; chain: ETradeOptionChain }>;
          filter: OptionScreenerFilter;
          fetchErrors: OptionScreenFetchError[];
          symbols: string[];
          warnings: string[];
        }>(storage, input, "chainFetch");
        const enriched = await loadArtifact<{
          outcomes: Parameters<typeof aggregateScreenResult>[0];
        }>(storage, input, "enrich");
        // #1963: a leg fails by RESULT STATUS. Nothing fetched at all
        // is an error-status leg - throw so the run fails loudly with
        // the reason, instead of reporting a legitimate empty.
        if (fetched.fetchErrors.length > 0 && fetched.chains.length === 0) {
          const reasons = fetched.fetchErrors
            .map((e) => `${e.symbol ?? "options"}: ${e.reason ?? "fetch failed"}`)
            .join("; ");
          throw new Error(`no chains could be fetched: ${reasons}`);
        }
        let result = aggregateScreenResult(
          enriched.outcomes,
          fetched.chains,
          fetched.filter,
          fetched.symbols.length,
          { fetchErrors: fetched.fetchErrors, warnings: fetched.warnings },
          screener.config,
        );
        // Demo-mode fallback (#65): generated chains substitute for
        // an empty live screen ONLY in dev/demo deployments with the
        // gate enabled. Production is live-only: an empty live screen
        // returns empty, with its fetch errors. The fallback runs
        // here (not the caller) so the canonical row's summary
        // reflects the result the run actually delivered.
        if (
          result.contracts.length === 0 &&
          deps.demoFallback &&
          fetched.filter.underlyingSymbols &&
          fetched.filter.underlyingSymbols.length > 0 &&
          fetched.filter.underlyingSymbols[0] !== "BROKEN"
        ) {
          const { buildCalibratedOptionChains } = await import("../trading");
          const fallbackChains = buildCalibratedOptionChains(
            fetched.filter.underlyingSymbols,
            fetched.filter.minDte ?? 0,
            fetched.filter.maxDte ?? 90,
          );
          if (fallbackChains.length > 0) {
            const chainItems = fallbackChains.map((c) => ({ symbol: c.symbol, chain: c }));
            const fallbackResult = screener.evaluateChains(chainItems, fetched.filter, fetched.filter.underlyingSymbols.length, {
              warnings: ["Calibrated demo chains — generated data for development/demo, not live market data."],
            });
            if (fallbackResult.contracts.length > 0) {
              fallbackResult.dataSource = "calibrated-demo";
              result = fallbackResult;
            }
          }
        }
        if (result.dataSource === undefined) result.dataSource = "live";
        const terminal =
          fetched.fetchErrors.length > 0
            ? "partial"
            : result.matchedCount === 0
              ? "no_contracts"
              : "completed";
        return { terminal, result };
      },
      persist: (input, output) => persist(input, output),
    },
    risk: {
      execute: async (input) => {
        const request = asRequest(input);
        const screened = await loadArtifact<{ result: { contracts: unknown[] } }>(
          storage,
          input,
          "screen",
        );
        const intent = request.classInput?.tradeIntent;
        if (!intent || intent.kind !== "options") {
          return {
            terminal: "completed",
            assessment: {
              status: "unassessed",
              reason: "no trade intent in this run; risk not assessed, never blocks",
            },
          };
        }
        const assessment = assessSagaTradeRisk({
          intent,
          limits: request.classInput?.riskLimits,
          contracts: screened.result.contracts as never,
        });
        if (assessment.status === "assessed" && assessment.kind === "options" && assessment.violation) {
          return { terminal: "violation", assessment };
        }
        return { terminal: "completed", assessment };
      },
      persist: (input, output) => persist(input, output),
    },
    persistCanonicalResults: {
      execute: async (input) => {
        const request = asRequest(input);
        const screened = await loadArtifact<{ terminal: string; result: { filterSummary?: string; matchedCount?: number; totalUnderlyingsScanned?: number } }>(
          storage,
          input,
          "screen",
        );
        const result = screened.result;
        const record: UnifiedOptionsRunRecord = deps.record
          ? await deps.record({
              runId: input.runId,
              userLogin: requireLogin(input),
              request,
              screen: { terminal: screened.terminal, result: result as Record<string, unknown> },
            })
          : {
              runId: input.runId,
              generationId: input.runId,
              title: "Options screen",
              source: "options-screen-workflow",
              summary:
                result.filterSummary ??
                `${result.matchedCount ?? 0} matches across ${result.totalUnderlyingsScanned ?? 0} underlyings`,
              trigger: request.trigger === "scheduled" ? "scheduled" : "manual",
              ...(request.classInput?.goalPlan?.goalId || request.classInput?.goalId
                ? { goalId: request.classInput.goalPlan?.goalId ?? request.classInput.goalId }
                : {}),
              userLogin: requireLogin(input),
            };
        // #4060: the canonical write rides the engine's tenant-aware
        // leg when bound (the door into the report-owning tenant's
        // Orchestrator DO); the leg wins over the direct store when
        // both are bound — one row, one transport. With neither
        // bound the stage records the goal leg's decided omission
        // (created:false, no mas_reports row) with its coded reason.
        // Either way the write never fails the run.
        let created = false;
        let reportId: string | null = null;
        let canonicalLeg: OptionsCanonicalLegReport;
        if (deps.canonicalLeg) {
          const legResult = await recordUnifiedOptionsRunThroughLeg(deps.canonicalLeg, record);
          created = legResult.created;
          reportId = legResult.reportId;
          canonicalLeg = {
            status: legResult.status,
            ...(legResult.reason ? { reason: legResult.reason } : {}),
          };
        } else if (canonical) {
          const stored = recordUnifiedOptionsRun(canonical, record);
          created = stored?.created ?? false;
          reportId = stored?.reportId ?? null;
          canonicalLeg = { status: "direct" };
        } else {
          canonicalLeg = {
            status: "omitted",
            reason: OPTIONS_CANONICAL_LEG_REASONS.omittedGoalLeg,
          };
        }
        return {
          terminal: "completed",
          created,
          reportId,
          record,
          canonicalLeg,
        };
      },
      persist: (input, output) => persist(input, output),
    },
    shapeReport: {
      execute: async (input) => {
        const request = asRequest(input);
        const canonicalArtifact = await loadArtifact<{
          created: boolean;
          reportId: string | null;
          record: UnifiedOptionsRunRecord;
        }>(storage, input, "persistCanonicalResults");
        const screenArtifact = await loadArtifact<unknown>(storage, input, "screen");
        const report = await deps.shapeReport({
          runId: input.runId,
          userLogin: requireLogin(input),
          request,
          canonical: canonicalArtifact,
          screen: screenArtifact,
        });
        return { terminal: readOutputTerminal(report) ?? "completed", report };
      },
      persist: (input, output) => persist(input, output),
    },
    deliver: {
      execute: async (input) => {
        const request = asRequest(input);
        const reportArtifact = await loadArtifact<{ report: unknown }>(
          storage,
          input,
          "shapeReport",
        );
        const delivery = await deps.deliver({
          runId: input.runId,
          userLogin: requireLogin(input),
          request,
          report: reportArtifact.report,
        });
        return { terminal: readOutputTerminal(delivery) ?? "completed", deliveryState: delivery };
      },
      persist: (input, output) => persist(input, output),
    },
  };
}
