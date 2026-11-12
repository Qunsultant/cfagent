/**
 * Issue #3186 (step 3e) - the strategy leg's production ports: one
 * OptionsStagePort per pipeline stage, over the panel engine's
 * extracted stage functions (recommendationKernel.ts). The composer
 * (optionsScreenWorkflow.ts) runs them in pipeline order with the
 * same claim + persist + publish discipline as the plain screen.
 *
 * The strategy leg rides the options family's pipeline (same 8 stage
 * ids, family "options" on the messages). The catalog's strategy
 * display steps (feed/analysis/generation/delivery) are a display
 * mapping, not execution stages - they are not what the pipeline
 * publishes.
 *
 * Persist discipline: the panel path has NO canonical scan row (the
 * NLQ panel action returns its envelope directly; only the scanner
 * path saves via ScanRunStore). The panel persist stage therefore
 * carries the screen + risk artifacts forward - the stage artifact
 * IS the panel run's record - and says so explicitly, rather than
 * inventing a canonical write. The scanner leg's persist port (a
 * later slice) substitutes ScanRunStore.save here.
 *
 * Delivery discipline: like the goal leg, the strategy leg DEFERS
 * delivery to its caller (the NLQ action formats the envelope; the
 * scheduled service delivers). The deliver stage records the handoff.
 */
import {
  assemblePanelResult,
  buildPanelKernelSnapshot,
  panelRiskReports,
  runPanelScreen,
  type PanelDiscoveryInput,
  type PanelDiscoveryResult,
  type PanelRecommender,
  type PanelRiskAgent,
  type PanelSnapshotData,
} from "../services/recommendationKernel";
// Issue #4066: these values come from the trading barrel
// (src/trading/index.ts), the sole public import surface under the
// #290 boundary — leaf imports of trading internals trip the
// boundary test.
import {
  buildPanelFetchDteBands,
  DynamicOptionsScreener,
  OptionsDataAgent,
  RecommendationAgent,
  StrategyRiskAgent,
  type PipelineResult,
  type StrategyRequest,
} from "../trading";
import type { OptionsPipelineStage } from "./stageRuntimeIds";
import type { OptionsStagePort } from "./optionsScreenWorkflow";
import { optionsArtifactKey, type OptionsStageStorage } from "./optionsScreenPorts";
import type { PlannerInput } from "./blocks/plannerPort";

/**
 * runPanelWithAgents' mapping, as a shared function: a panel result
 * (kernel result spread at top level) back to the PipelineResult shape
 * the NLQ envelope and the panel route read. Callers that migrate off
 * runPanelWithAgents use this instead of re-implementing the mapping.
 */
export function panelResultToPipelineResult(panel: PanelDiscoveryResult): PipelineResult {
  const snapshot = panel.snapshot;
  return {
    snapshot: {
      symbol: snapshot.symbol,
      contracts: snapshot.contracts ?? [],
      dataSource: snapshot.dataSource,
      screen: snapshot.screen as PipelineResult["snapshot"]["screen"],
      rejections: snapshot.rejections as PipelineResult["snapshot"]["rejections"],
      validationError: snapshot.validationError,
    },
    strategies: panel.legacy?.buildResult as unknown as PipelineResult["strategies"],
    screenedOut: panel.screenedOut,
    ranked: panel.ranked,
    riskReports: panel.riskReports as PipelineResult["riskReports"],
    bestTrade: panel.bestTrade as PipelineResult["bestTrade"],
  };
}

/** The strategy leg's run request: a panel run, not a plain screen. */
export interface StrategyPipelineRequest extends PlannerInput {
  classInput: {
    strategyRequest?: StrategyRequest;
    strategyFilter?: PanelDiscoveryInput["strategyFilter"];
    riskProfile?: PanelDiscoveryInput["riskProfile"];
    alternatives?: number;
    snapshotOverride?: PanelSnapshotData;
  };
}

/** The three agents a panel run is composed of (structural, like the panel pipeline's PanelAgents). */
export interface StrategyScreenAgents {
  // Method syntax (not a function property): the concrete
  // OptionsDataAgent.loadSnapshot takes SnapshotParams, narrower than
  // unknown - method bivariance admits it, strict function-property
  // checking would not.
  data: { loadSnapshot(params: unknown): Promise<PanelSnapshotData> };
  risk: PanelRiskAgent;
  recommender: PanelRecommender;
}

export interface StrategyScreenPortDeps {
  agents: StrategyScreenAgents;
  storage: OptionsStageStorage;
}

type StageInput = Parameters<OptionsStagePort["execute"]>[0];

function loadArtifact<T>(storage: OptionsStageStorage, runId: string, stageId: string): Promise<T> {
  // Same discipline as the plain ports: always the deterministic
  // checkpoint key, never artifactKeys[0]; a missing artifact is a
  // loud refusal, never a run on unpersisted input.
  const key = optionsArtifactKey(runId, stageId);
  return storage.get<T>(key).then((value) => {
    if (value === undefined) {
      throw new Error(`${stageId} artifact missing for run ${runId} (${key}); refusing to run a stage on input that was never persisted.`);
    }
    return value;
  });
}

function panelInputFromPlan(
  agents: StrategyScreenAgents,
  plan: StrategyPipelineRequest["classInput"],
): PanelDiscoveryInput {
  return {
    dataAgent: agents.data,
    riskAgent: agents.risk,
    recommender: agents.recommender,
    request: plan.strategyRequest as StrategyRequest,
    strategyFilter: plan.strategyFilter,
    riskProfile: plan.riskProfile,
    alternatives: plan.alternatives,
  };
}

/**
 * The three agents a strategy leg is composed of, constructed in ONE
 * place. #982 S2 forbids direct engine construction in the NLQ layer
 * (the pin scans src/agents/nlqOptionsStrategy.ts for
 * `new DynamicOptionsScreener(`), so the NLQ legs call this factory
 * instead of constructing the agents inline. The factory lives here,
 * with the ports that consume the agents: engine construction stays
 * in the workflow layer and the NLQ layer keeps assembly only. Serves
 * both legs — the panel (structural StrategyScreenAgents) and the
 * scanner (concrete ScannerScreenAgents) take the same three concrete
 * agents.
 */
export function createStrategyScreenAgents(
  client: ConstructorParameters<typeof DynamicOptionsScreener>[0],
): ScannerScreenAgents {
  return {
    data: new OptionsDataAgent(new DynamicOptionsScreener(client)),
    risk: new StrategyRiskAgent(),
    recommender: new RecommendationAgent(),
  };
}

/**
 * The strategy leg's ports. Each execute reads ONLY the persisted
 * artifacts of earlier stages (by deterministic key) and its own
 * plan; each persist writes its output to its stage key.
 */
export function createStrategyScreenPorts(
  deps: StrategyScreenPortDeps,
): Record<OptionsPipelineStage, OptionsStagePort> {
  const { agents, storage } = deps;
  const persist = async (input: StageInput, output: unknown): Promise<string[]> => {
    const key = optionsArtifactKey(input.runId, input.stageId);
    await storage.put(key, output);
    return [key];
  };

  const plan: OptionsStagePort = {
    async execute(input) {
      const request = (input.request as StrategyPipelineRequest).classInput?.strategyRequest;
      if (!request?.symbol) {
        throw new Error("strategy plan: missing symbol - refusing to run a panel without a name");
      }
      const planInput = (input.request as StrategyPipelineRequest).classInput;
      return {
        strategyRequest: request,
        strategyFilter: planInput.strategyFilter,
        riskProfile: planInput.riskProfile,
        alternatives: planInput.alternatives,
        snapshotOverride: planInput.snapshotOverride,
        expirationDteBands: buildPanelFetchDteBands({
          thesis: request.thesis,
          allowedStrategies: request.allowedStrategies,
          minDte: request.minDte,
          maxDte: request.maxDte,
        }),
      };
    },
    persist,
  };

  const chainFetch: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<{
        strategyRequest: StrategyRequest;
        snapshotOverride?: PanelSnapshotData;
        expirationDteBands: unknown;
      }>(storage, input.runId, "plan");
      // The runPanelWithAgents adapter, verbatim: a stored snapshot
      // runs instead of live-loading; the result maps to the six
      // fields the kernel consumes.
      const snapshot = planArtifact.snapshotOverride ?? (await agents.data.loadSnapshot({
        ...planArtifact.strategyRequest,
        expirationDteBands: planArtifact.expirationDteBands,
      }));
      return {
        symbol: snapshot.symbol,
        contracts: snapshot.contracts,
        dataSource: snapshot.dataSource,
        screen: snapshot.screen,
        rejections: snapshot.rejections,
        validationError: snapshot.validationError,
      };
    },
    persist,
  };

  const enrich: OptionsStagePort = {
    async execute(input) {
      const data = await loadArtifact<PanelSnapshotData>(storage, input.runId, "chainFetch");
      return buildPanelKernelSnapshot(data);
    },
    persist,
  };

  const screen: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<{
        strategyRequest: StrategyRequest;
        strategyFilter: PanelDiscoveryInput["strategyFilter"];
        riskProfile: PanelDiscoveryInput["riskProfile"];
        alternatives: number | undefined;
      }>(storage, input.runId, "plan");
      const snapshot = await loadArtifact<Parameters<typeof runPanelScreen>[0]>(
        storage,
        input.runId,
        "enrich",
      );
      const panelInput = panelInputFromPlan(agents, planArtifact);
      return runPanelScreen(snapshot, panelInput);
    },
    persist,
  };

  const risk: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<{
        strategyRequest: StrategyRequest;
        strategyFilter: PanelDiscoveryInput["strategyFilter"];
        riskProfile: PanelDiscoveryInput["riskProfile"];
        alternatives: number | undefined;
      }>(storage, input.runId, "plan");
      const screenArtifact = await loadArtifact<{ ranked: Parameters<typeof panelRiskReports>[0] }>(
        storage,
        input.runId,
        "screen",
      );
      const panelInput = panelInputFromPlan(agents, planArtifact);
      return { riskReports: panelRiskReports(screenArtifact.ranked, panelInput) };
    },
    persist,
  };

  const persistCanonicalResults: OptionsStagePort = {
    async execute(input) {
      // No canonical scan row exists for panel runs (only the scanner
      // path saves via ScanRunStore). The stage artifact carries the
      // screen + risk artifacts forward; the persist() below writes
      // them to the stage key, which IS the panel run's record.
      const screenArtifact = await loadArtifact<unknown>(storage, input.runId, "screen");
      const riskArtifact = await loadArtifact<unknown>(storage, input.runId, "risk");
      return {
        persisted: false,
        reason: "panel runs carry no canonical scan row; the stage artifact is the record",
        screen: screenArtifact,
        risk: riskArtifact,
      };
    },
    persist,
  };

  const shapeReport: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<{
        strategyRequest: StrategyRequest;
        strategyFilter: PanelDiscoveryInput["strategyFilter"];
        riskProfile: PanelDiscoveryInput["riskProfile"];
        alternatives: number | undefined;
      }>(storage, input.runId, "plan");
      const screenArtifact = await loadArtifact<Parameters<typeof assemblePanelResult>[0]["screen"]>(
        storage,
        input.runId,
        "screen",
      );
      const riskArtifact = await loadArtifact<{ riskReports: unknown[] }>(
        storage,
        input.runId,
        "risk",
      );
      const panelInput = panelInputFromPlan(agents, planArtifact);
      return assemblePanelResult({ screen: screenArtifact, riskReports: riskArtifact.riskReports, panelInput });
    },
    persist,
  };

  const deliver: OptionsStagePort = {
    async execute(input) {
      const report = await loadArtifact<unknown>(storage, input.runId, "shapeReport");
      return {
        terminal: "completed",
        deliveryState: "deferred-to-caller",
        runId: input.runId,
        report,
      };
    },
    persist,
  };

  return {
    plan,
    chainFetch,
    enrich,
    screen,
    risk,
    persistCanonicalResults,
    shapeReport,
    deliver,
  };
}

/* ------------------------------------------------------------------ */
/* Scanner leg (step 3e): the opportunity scan over a symbol batch.   */
/* ------------------------------------------------------------------ */

// Issue #4066: these values come from the trading barrel
// (src/trading/index.ts), the sole public import surface under the
// #290 boundary — leaf imports of trading internals trip the
// boundary test.
import {
  assessScanRisk,
  collateScanResult,
  enrichScanSnapshots,
  fetchScanSnapshots,
  normalizeScanPlan,
  screenScanCandidates,
  type OpportunityScanOptions,
  type OpportunityScanResult,
  type OptionsDataSnapshot,
  type ScanAssessedRow,
  type ScanPlan,
  type ScanRequestRecord,
  type ScanRequestTemplate,
  type ScanSkipped,
  type SubrequestBudget,
} from "../trading";
import type { ScanRunStore } from "../data/scanRunPorts";

/** The scanner leg's run request: an opportunity scan over a batch. */
export interface ScannerPipelineRequest extends PlannerInput {
  classInput: {
    scan: { symbols: string[]; template: ScanRequestTemplate; options?: OpportunityScanOptions };
    /** The caller's replayable request record (#103), attached to the
     *  result BEFORE the persist stage saves it, exactly as
     *  UnifiedOptionsService.execute does. */
    requestRecord?: ScanRequestRecord;
    /** A run id minted before the scan (#1157, E2): platform-wired
     *  runs persist under it so fetch-time captures share one identity. */
    platformRunId?: string;
    /** Issue #3327: the broker whose chains this run reads, stamped on
     *  the saved run by the persist stage. Absent, the run records
     *  E*TRADE (the pre-provenance default) — never a guess. */
    broker?: "etrade" | "alpaca" | "public"; // Issue #3990
    /** Issue #3264: the producing run's trigger, stamped on the saved
     *  run by the persist stage so the history row can say how the run
     *  started. Absent, the row records none — never a guess. Carried
     *  for UnifiedOptionsService.execute()'s opportunities case, which
     *  stamped it on its direct save; the scanner legs that never had
     *  one (unified route, NLQ scan) omit it, unchanged. */
    trigger?: "manual" | "scheduled";
  };
}

/** The three agents a scanner run is composed of: the same agents as
 *  the panel (OptionsDataAgent + StrategyRiskAgent +
 *  RecommendationAgent) — the CONCRETE agent types, not the panel's
 *  looser structural views, because the scanner's engine-typed
 *  rank/pick calls need the tight StrategyCandidate / BestTradePick
 *  types. Production callers pass the real agents; test fakes cast. */
export interface ScannerScreenAgents {
  data: OptionsDataAgent;
  risk: StrategyRiskAgent;
  recommender: RecommendationAgent;
}

export interface ScannerScreenPortDeps {
  agents: ScannerScreenAgents;
  storage: OptionsStageStorage;
  /** The canonical scan-run store (mas_opportunity_scans). Absent,
   *  the persist stage records the result in its stage artifact and
   *  says so — the scan still completes; only the durable row is missing. */
  scanRunStore?: ScanRunStore;
}

function scannerScanOptions(input: StageInput): OpportunityScanOptions {
  return (input.request as ScannerPipelineRequest).classInput?.scan?.options ?? {};
}

/**
 * The scanner leg's ports. Each execute reads ONLY the persisted
 * artifacts of earlier stages (by deterministic key) plus the run
 * request's scan options; each persist writes its output to its
 * stage key. Terminals: a stage with per-symbol skips reports
 * "partial" (the run continues — per-symbol failure never fails a
 * scan); risk reports "no_contracts" when no symbol produced a pick
 * (a legitimate complete per #2038); persist NEVER fails the run
 * (the #27/#103 never-fails-the-scan discipline: a store error is
 * recorded, the result still returns).
 */
export function createScannerScreenPorts(
  deps: ScannerScreenPortDeps,
): Record<OptionsPipelineStage, OptionsStagePort> {
  const { agents, storage, scanRunStore } = deps;
  const persist = async (input: StageInput, output: unknown): Promise<string[]> => {
    const key = optionsArtifactKey(input.runId, input.stageId);
    await storage.put(key, output);
    return [key];
  };

  const plan: OptionsStagePort = {
    async execute(input) {
      const scan = (input.request as ScannerPipelineRequest).classInput?.scan;
      if (!scan?.symbols || scan.symbols.length === 0) {
        throw new Error("scanner plan: missing symbols - refusing to run a scan over nothing");
      }
      if (!scan.template) {
        throw new Error("scanner plan: missing scan template - refusing to run a scan without a request");
      }
      return normalizeScanPlan(scan.symbols, scan.template, scan.options ?? {});
    },
    persist,
  };

  const chainFetch: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<ScanPlan>(storage, input.runId, "plan");
      const { snapshots, skipped } = await fetchScanSnapshots(agents.data, planArtifact);
      return {
        terminal: skipped.length > 0 ? "partial" : "completed",
        snapshots,
        skipped,
      };
    },
    persist,
  };

  const enrich: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<ScanPlan>(storage, input.runId, "plan");
      const fetchArtifact = await loadArtifact<{
        snapshots: Parameters<typeof enrichScanSnapshots>[0];
        skipped: ScanSkipped[];
      }>(storage, input.runId, "chainFetch");
      const { enriched, skipped } = enrichScanSnapshots(
        fetchArtifact.snapshots,
        planArtifact,
        scannerScanOptions(input),
      );
      return {
        terminal: skipped.length > 0 ? "partial" : "completed",
        enriched,
        skipped,
      };
    },
    persist,
  };

  const screen: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<ScanPlan>(storage, input.runId, "plan");
      const enrichArtifact = await loadArtifact<{
        enriched: Parameters<typeof screenScanCandidates>[0];
        skipped: ScanSkipped[];
      }>(storage, input.runId, "enrich");
      const { screened, skipped } = screenScanCandidates(
        enrichArtifact.enriched,
        agents.risk,
        agents.recommender,
        planArtifact,
        scannerScanOptions(input),
      );
      return {
        terminal: skipped.length > 0 ? "partial" : "completed",
        screened,
        skipped,
      };
    },
    persist,
  };

  const risk: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<ScanPlan>(storage, input.runId, "plan");
      const screenArtifact = await loadArtifact<{
        screened: Parameters<typeof assessScanRisk>[0];
        skipped: ScanSkipped[];
      }>(storage, input.runId, "screen");
      const { assessed, gate } = assessScanRisk(screenArtifact.screened, planArtifact);
      return {
        terminal: assessed.some((row) => row.opportunity) ? "completed" : "no_contracts",
        assessed,
        gate,
      };
    },
    persist,
  };

  const persistCanonicalResults: OptionsStagePort = {
    async execute(input) {
      const planArtifact = await loadArtifact<ScanPlan>(storage, input.runId, "plan");
      const riskArtifact = await loadArtifact<{
        assessed: ScanAssessedRow[];
        gate: { fit: number; borderline: number; noFit: number };
      }>(storage, input.runId, "risk");
      const fetchArtifact = await loadArtifact<{ skipped: ScanSkipped[] }>(storage, input.runId, "chainFetch");
      const enrichArtifact = await loadArtifact<{ skipped: ScanSkipped[] }>(storage, input.runId, "enrich");
      const screenArtifact = await loadArtifact<{ skipped: ScanSkipped[] }>(storage, input.runId, "screen");
      const result = collateScanResult(
        planArtifact,
        riskArtifact.assessed,
        [...fetchArtifact.skipped, ...enrichArtifact.skipped, ...screenArtifact.skipped],
        scannerScanOptions(input),
        riskArtifact.gate,
      );
      const classInput = (input.request as ScannerPipelineRequest).classInput;
      if (classInput?.requestRecord) {
        result.requestSnapshot.request = classInput.requestRecord;
      }
      if (!scanRunStore) {
        // Issue #4068 (fix): a run with no store bound carries NO
        // persistence fields at all — the field is absent, not false.
        // (A store whose save throws is the pinned persisted:false
        // case below; a run that never had a store has no receipt to
        // report, and the execute() test pins the field absent.)
        return {
          terminal: "completed",
          saved: false,
          reason: "no scan run store bound; the stage artifact is the record",
          result,
        };
      }
      try {
        const saved = await scanRunStore.save(result, {
          // The scanner leg's pinned discipline (#27/#103): a run
          // without an identity saves unscoped - the login is never
          // invented here. The composer publishes no stage messages
          // for such a run (stageMessage refuses an empty login).
          ...(input.userLogin ? { userLogin: input.userLogin } : {}),
          ...(classInput?.platformRunId ? { id: classInput.platformRunId } : {}),
          // Issue #3327: stamp the broker whose chains the run read
          // (threaded in classInput by the NLQ scanner leg); absent,
          // the store normalizes to E*TRADE, the pre-provenance default.
          ...(classInput?.broker ? { broker: classInput.broker } : {}),
          // Issue #3264: stamp the producing run's trigger when the
          // caller threaded one (execute()'s opportunities case);
          // absent, the row records none.
          ...(classInput?.trigger ? { trigger: classInput.trigger } : {}),
        });
        return { terminal: "completed", saved: true, scanRunId: saved.id, persisted: true, result };
      } catch (err) {
        console.error("Failed to persist opportunity scan run", err);
        return {
          terminal: "completed",
          saved: false,
          reason: err instanceof Error ? err.message : "scan run store save failed",
          persisted: false,
          result,
        };
      }
    },
    persist,
  };

  const shapeReport: OptionsStagePort = {
    async execute(input) {
      const persistArtifact = await loadArtifact<{
        saved: boolean;
        scanRunId?: string;
        persisted?: boolean;
        result: OpportunityScanResult;
      }>(storage, input.runId, "persistCanonicalResults");
      // The execute() executionData shape: the result plus its save
      // receipt, so callers read one object either way. No terminal
      // field: the composer defaults an absent terminal to
      // "completed", and a terminal here would leak into the shaped
      // result the deliver stage hands on. The receipt fields ride
      // only when the persist stage set them: a run with no store
      // bound carries no persisted field (#27), a failed save carries
      // persisted:false, a saved run carries scanRunId + persisted:true.
      return {
        ...persistArtifact.result,
        ...(persistArtifact.scanRunId ? { scanRunId: persistArtifact.scanRunId } : {}),
        ...(persistArtifact.persisted !== undefined ? { persisted: persistArtifact.persisted } : {}),
      };
    },
    persist,
  };

  const deliver: OptionsStagePort = {
    async execute(input) {
      const report = await loadArtifact<unknown>(storage, input.runId, "shapeReport");
      return {
        terminal: "completed",
        deliveryState: "deferred-to-caller",
        runId: input.runId,
        report,
      };
    },
    persist,
  };

  return {
    plan,
    chainFetch,
    enrich,
    screen,
    risk,
    persistCanonicalResults,
    shapeReport,
    deliver,
  };
}
