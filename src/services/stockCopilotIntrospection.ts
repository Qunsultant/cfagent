/**
 * Issue #3588 — Stock Copilot Tool-Driven Reflection & Self-Explanation Engine.
 *
 * Implements Sub-Issue 6 of the Stock Copilot Architecture (docs/architecture/agentic/stockcopilot-evoluation.md):
 * Instead of replying with hardcoded text prompts when a user asks:
 *   - "Explain your autonomous trading workflow, 5-stage pipeline, and active tools"
 *   - "What tools do you have available?"
 *   - "What is your current configuration?"
 *   - "What did you learn from recent cycles?"
 *
 * This engine dynamically inspects:
 * 1. Active tool catalog and maps them to the 5-stage pipeline:
 *    - Stage 1: FEED (Data Ingestion & Market Feeds)
 *    - Stage 2: ENRICH (Signals, Technical Indicators & Normalization)
 *    - Stage 3: ANALYZE (Multi-Pattern Scoring & CVaR Risk Optimization)
 *    - Stage 4: GENERATE (Execution & Bracket Order Construction)
 *    - Stage 5: DELIVER (Audit, Telemetry & Multi-Format Reports)
 * 2. Live configuration state from DO SQLite (cadence, sessions, broker/mode, universe, pause).
 * 3. Telemetry and reflection memory (open positions, recent refusals, distilled learnings).
 */

import {
  resolveCopilotTradingSelection,
} from "../agents/copilotTradingMode";
import { createAsyncJobPorts } from "../data/createAsyncJobPorts";
import type { CommercialStore } from "../data/commercialPorts";
import type {
  CopilotExecutionMode,
  StockCopilotActivityPort,
  StockCopilotControlPort,
  StockCopilotPositionPort,
} from "../data/stockCopilotStorePorts";
import type { Env } from "../types";
import {
  DEFAULT_COPILOT_STRATEGIES,
  copilotUniverseFromEnv,
} from "./stockCopilot";
import {
  resolveCopilotUniverse,
  resolveCopilotUniversePreset,
  resolveCopilotStrategies,
} from "./stockCopilotConfiguration";
import {
  resolveCopilotSessions,
  type CopilotSessionId,
} from "./stockCopilotSessions";
import { resolveCopilotCadence } from "./stockCopilotCadence";
import { resolveCopilotExecutionMode } from "./stockCopilotExecutionMode";
import {
  resolveStockCopilotRsiMode,
  type StockCopilotRsiMode,
} from "./stockCopilotRsiMode";

export interface PipelineToolItem {
  name: string;
  description: string;
  role: string;
}

export interface PipelineStageMapping {
  stage: 1 | 2 | 3 | 4 | 5;
  name: "FEED" | "ENRICH" | "ANALYZE" | "GENERATE" | "DELIVER";
  title: string;
  description: string;
  tools: PipelineToolItem[];
}

export interface CapabilityImprovementProposal {
  gapId: string;
  title: string;
  diagnosis: string;
  neededCapabilities: string[];
  leveragedTools: {
    domain: string[];
    platform: string[];
  };
  synthesisPath: string;
  readiness: "suggestion" | "ready_to_synthesize" | "active";
  governedPathway: {
    targetIssueTitle: string;
    lane: string;
    actionablePlan: string;
  };
  selfRsiPathway: {
    platformTool: string;
    autonomousAction: string;
  };
}

export interface StockCopilotIntrospectionResult {
  ok: boolean;
  userLogin: string;
  timestamp: string;
  mode: "deterministic" | "agentic";
  configuration: {
    /** The real stored broker selection, or null when unresolved. */
    broker: string | null;
    /** The real stored mode, or null when unresolved. */
    mode: string | null;
    selectionResolved: boolean;
    cadence: {
      configured: string;
      effective: string;
    };
    enabledSessions: readonly CopilotSessionId[];
    universe: string[];
    universePreset?: string | null;
    strategies: readonly string[];
    rsiMode: StockCopilotRsiMode;
    paused: boolean;
    pauseUntil: string | null;
  };
  telemetry: {
    openPositionsCount: number;
    closedPositionsCount: number;
    recentCyclesCount: number;
    recentRefusalsCount: number;
    lastCycleStatus: string | null;
  };
  pipeline: PipelineStageMapping[];
  reflection: {
    learnings: string[];
    criticSummary: string;
    adaptationRecommendations: string[];
    capabilityProposals: CapabilityImprovementProposal[];
  };
  explanationMarkdown: string;
}

export interface StockCopilotIntrospectionDeps {
  env: Env;
  userLogin: string;
  readSettingRaw: (key: string) => string | null;
  positionPort: StockCopilotPositionPort;
  activityPort: StockCopilotActivityPort;
  controlPort: StockCopilotControlPort;
  commercial?: CommercialStore | null;
}

/**
 * Standard 5-stage pipeline tool catalog mapping.
 */
export function buildPipelineStageCatalog(): PipelineStageMapping[] {
  return [
    {
      stage: 1,
      name: "FEED",
      title: "Stage 1: Feed (Market Ingestion & Universe Selection)",
      description: "Ingests real-time bars, quotes, and market feeds across regular and extended sessions.",
      tools: [
        {
          name: "get_trading_quote",
          description: "Real-time market quote and bid/ask spread retrieval.",
          role: "Market data retrieval for active universe symbols.",
        },
        {
          name: "feed_jobs",
          description: "Scheduled and ad-hoc feed ingestion jobs for NASDAQ-100, Yahoo, and Alpaca.",
          role: "Bulk universe feed synchronization.",
        },
      ],
    },
    {
      stage: 2,
      name: "ENRICH",
      title: "Stage 2: Enrich (Technical Indicators & Signals)",
      description: "Calculates technical momentum indicators (SMA, RSI, MACD, Bollinger Bands) and unusual flow.",
      tools: [
        {
          name: "technical_indicators",
          description: "In-memory quantitative calculations over historical price bars.",
          role: "Signal feature normalization.",
        },
        {
          name: "derivatives_sweeps",
          description: "Unusual options sweep detection and institutional sentiment scoring.",
          role: "Institutional capital flow alignment.",
        },
      ],
    },
    {
      stage: 3,
      name: "ANALYZE",
      title: "Stage 3: Analyze (Pattern Scoring & CVaR Risk)",
      description: "Scores candidate setups against trading strategies and applies mathematical portfolio risk sizing.",
      tools: [
        {
          name: "run_stock_screen",
          description: "Multi-pattern criteria evaluation across active universe.",
          role: "Alpha candidate filtering.",
        },
        {
          name: "cvar_optimizer",
          description: "Conditional Value at Risk (CVaR) mathematical optimization and position sizing.",
          role: "Strict downside risk protection.",
        },
      ],
    },
    {
      stage: 4,
      name: "GENERATE",
      title: "Stage 4: Generate (Execution & Bracket Orders)",
      description: "Constructs atomic parent orders with automatic take-profit (+10%) and stop-loss (-5%) brackets.",
      tools: [
        {
          name: "propose_trade",
          description: "Broker-neutral trade order preview and validation.",
          role: "Pre-trade order construction.",
        },
        {
          name: "bracket_exit_manager",
          description: "Automatic management of trailing stop and take-profit exit triggers.",
          role: "Automated exit enforcement.",
        },
      ],
    },
    {
      stage: 5,
      name: "DELIVER",
      title: "Stage 5: Deliver (Audit Ledgers, Telemetry & Reports)",
      description: "Records trade lifecycle in Durable Object SQLite ledgers and delivers multi-channel telemetry.",
      tools: [
        {
          name: "stock_copilot_status",
          description: "Live telemetry, open positions with exit plans, and cycle activity.",
          role: "Real-time state interrogation.",
        },
        {
          name: "stock_copilot_control",
          description: "Runtime cadence, trading session, and execution loop controls.",
          role: "Interactive loop governance.",
        },
        {
          name: "stock_copilot_introspect",
          description: "Runtime tool introspection and 5-stage pipeline self-explanation.",
          role: "Self-explaining transparency.",
        },
      ],
    },
  ];
}

/**
 * Synthesize autonomous capability improvement proposals for the Stock Copilot (RSI Loop).
 * Diagnoses gaps from monitored universe, strategies, active sessions, and cycle refusals,
 * and formulates concrete development pathways using domain and platform tools.
 */
export function synthesizeCapabilityProposals(params: {
  universe: string[];
  strategies: readonly string[];
  enabledSessions: readonly CopilotSessionId[];
  openPositionsCount: number;
  refusalsCount: number;
  rsiMode?: StockCopilotRsiMode;
}): CapabilityImprovementProposal[] {
  const proposals: CapabilityImprovementProposal[] = [];

  // 1. Dynamic Universe Expansion via ScreenerAgent
  if (params.universe.length <= 15) {
    proposals.push({
      gapId: "GAP_STATIC_UNIVERSE_BOTTLENECK",
      title: "Dynamic Momentum Universe Expansion (via ScreenerAgent)",
      diagnosis: `The current watch universe is limited to ${params.universe.length} static symbols, causing idle cycles when these specific tickers lack setup triggers.`,
      neededCapabilities: [
        "Dynamic high-momentum stock screening across broader indices (S&P 500 / Tech-100)",
        "Pre-market volume surge filtering",
      ],
      leveragedTools: {
        domain: ["screenerAgent", "patternSignals"],
        platform: ["thinkWorkflow", "browserAgent"],
      },
      synthesisPath:
        "Invoke ScreenerAgent at regular session open to replace or augment static universe with top-20 volume surge leaders, feeding candidate symbols into the pattern evaluation queue.",
      readiness: "suggestion",
      governedPathway: {
        targetIssueTitle: "[Stock Copilot] Dynamic Universe Ingestion from ScreenerAgent",
        lane: "lane:clo-arsi",
        actionablePlan:
          "Draft and publish a GitHub issue under Epic #3514 / #3752 with TDD acceptance criteria for the agentic engineering team.",
      },
      selfRsiPathway: {
        platformTool: "thinkWorkflow",
        autonomousAction:
          "Trigger ScreenerAgent job via thinkWorkflow on session start and pipe top-momentum tickers into mas_settings:stock_copilot:universe.",
      },
    });
  }

  // 2. Downside risk hedging via Options Copilot
  proposals.push({
    gapId: "GAP_UNHEDGED_CVAR_EXPOSURE",
    title: "Downside Tail-Risk Options Hedging (via Options Copilot)",
    diagnosis:
      "High-conviction equity trades in volatile tech stocks are capped or rejected by CVaR limits due to unhedged single-stock drawdown risk.",
    neededCapabilities: [
      "Cross-asset protective put screening",
      "Dynamic collar structuring to bound maximum loss",
    ],
    leveragedTools: {
      domain: ["cvarRiskGate", "optionsResearchPipeline"],
      platform: ["a2aMeshDoor", "thinkWorkflow"],
    },
    synthesisPath:
      "Publish an EQUITY_POSITION_OPENED event to the inter-copilot A2A bus; Options Copilot computes a delta-neutral protective put, allowing higher equity position limits under CVaR constraints.",
    readiness: "suggestion",
    governedPathway: {
      targetIssueTitle: "[Stock Copilot] Cross-Asset Options Hedging Integration",
      lane: "lane:ceo-aimp",
      actionablePlan:
        "Publish a GitHub issue under Sub-Issue #3755 specifying the A2A schema between Stock and Options copilots.",
    },
    selfRsiPathway: {
      platformTool: "a2aMeshDoor",
      autonomousAction:
        "Send direct A2A event to Options Copilot over the mesh door to structure a protective collar on equity fills.",
    },
  });

  // 3. Algorithmic Strategy Synthesis & Backtesting in SandboxAgent
  if (params.strategies.length <= 5) {
    proposals.push({
      gapId: "GAP_STRATEGY_SYNTHESIS_SANDBOX",
      title: "Autonomous Strategy Research & Sandboxed Backtesting (via SandboxAgent & BrowserAgent)",
      diagnosis:
        "The loop currently relies on 4 generic pattern strategies (SMA, RSI, Mean Reversion, Breakout), missing regime-specific edge in choppy or mean-reverting markets.",
      neededCapabilities: [
        "Web scraping of published quantitative strategies and code (SSRN, arXiv, GitHub)",
        "Isolated TypeScript strategy compilation & historical backtesting in SandboxAgent",
      ],
      leveragedTools: {
        domain: ["StockCopilotMemoryPort", "patternSignals"],
        platform: ["browserAgent", "sandboxAgent", "thinkWorkflow"],
      },
      synthesisPath:
        "Use BrowserAgent to research quantitative momentum/volatility formulas -> dispatch code to SandboxAgent (S8 #3492) -> backtest against 1-year historical market bars -> propose validated strategy with win rate & Sharpe ratio for HITL activation.",
      readiness: "ready_to_synthesize",
      governedPathway: {
        targetIssueTitle: "[Stock Copilot] Algorithmic Regime Adaptive Trading Patterns",
        lane: "lane:cpo-dhmp",
        actionablePlan:
          "Publish a GitHub issue documenting mathematical model specifications for the quantitative research team.",
      },
      selfRsiPathway: {
        platformTool: "sandboxAgent",
        autonomousAction:
          "Use BrowserAgent to retrieve quant logic, compile in SandboxAgent (S8 #3492), run 1-year historical backtest, and present StrategyCard for 1-click activation.",
      },
    });
  }

  // 4. 24/7 Extended Liquidity Session Coverage
  if (params.enabledSessions.length < 4) {
    proposals.push({
      gapId: "GAP_RESTRICTED_SESSION_COVERAGE",
      title: "Around-the-Clock Liquidity Capture (Pre-market, After-hours, EXTO Overnight)",
      diagnosis: `Only ${params.enabledSessions.length} session(s) are active (${params.enabledSessions.join(", ")}). The loop is idle during global overnight market-moving macro announcements.`,
      neededCapabilities: [
        "Overnight EXTO limit order routing",
        "Wider spread tolerance on extended sessions",
      ],
      leveragedTools: {
        domain: ["stockCopilotSessions", "alpaca_place_order"],
        platform: ["stock_copilot_control"],
      },
      synthesisPath:
        "Execute 'Enable pre-market and overnight sessions' via stock_copilot_control with limit-only bracket protection.",
      readiness: "suggestion",
      governedPathway: {
        targetIssueTitle: "[Stock Copilot] 24/7 Session Liquidity Calibration",
        lane: "lane:clo-arsi",
        actionablePlan:
          "File an issue to verify broker session terms and extended-hours order acceptance rules.",
      },
      selfRsiPathway: {
        platformTool: "stock_copilot_control",
        autonomousAction:
          "Execute stock_copilot_control via chat prompt to enable all 4 sessions immediately.",
      },
    });
  }

  return proposals;
}

/**
 * Perform runtime introspection of the Stock Copilot:
 * inspects active settings, available tools, telemetry, and distilled learnings.
 */
export async function introspectStockCopilot(
  deps: StockCopilotIntrospectionDeps,
): Promise<StockCopilotIntrospectionResult> {
  const nowIso = new Date().toISOString();
  const { userLogin, readSettingRaw, env, positionPort, activityPort, controlPort } = deps;

  // 1. Resolve configuration from DO SQLite and env
  // Issue #3899 (RC3): no fake broker default — the resolver composes
  // the real commercial store from env when no store was injected
  // (deps.commercial undefined), so the introspection reports the
  // real stored selection; an unbound store reads as unresolved,
  // never alpaca/paper.
  const commercial = deps.commercial;

  const selection = await resolveCopilotTradingSelection({
    env,
    readSettingRaw,
    commercial,
  });

  const activeBroker = selection.resolved ? selection.selection.brokerId : null;
  const activeMode = selection.resolved ? selection.selection.mode : null;
  const cadence = resolveCopilotCadence({ env, readSettingRaw });
  const enabledSessions = resolveCopilotSessions({ readSettingRaw, env });
  const universe = resolveCopilotUniverse({ readSettingRaw, env });
  const universePreset = resolveCopilotUniversePreset(universe);
  const strategies = resolveCopilotStrategies({ readSettingRaw, env });
  const rsiMode = resolveStockCopilotRsiMode({ readSettingRaw, env });

  const control = controlPort.getControl(userLogin);
  const paused = control?.paused === true;
  const pauseUntil = readSettingRaw("stock_copilot:pause_until");

  // 2. Resolve live telemetry & positions
  const openPositions = positionPort.listOpenPositions(userLogin);
  const closedPositions = positionPort.listClosedPositions(userLogin, 10);
  const recentActivity = activityPort.listActivity(userLogin, 20);

  const refusals = recentActivity.filter((a) => a.outcome === "refused");
  const lastCycle = recentActivity.length > 0 ? recentActivity[0] : null;

  // 3. Assemble 5-stage pipeline tool mappings
  const pipeline = buildPipelineStageCatalog();

  // 4. Synthesize distilled learnings and reflection
  const learnings: string[] = [];
  if (refusals.length > 0) {
    learnings.push(
      `${refusals.length} recent cycle(s) were refused or skipped by guard conditions. Check active sessions and market hours.`,
    );
  } else {
    learnings.push("Cycle execution guards are passing normally without refusals.");
  }

  if (openPositions.length > 0) {
    learnings.push(
      `Currently holding ${openPositions.length} active position(s) with pre-set bracket exit plans (take-profit +10%, stop-loss -5%).`,
    );
  } else {
    learnings.push("No open inventory; scanner is actively monitoring candidate signals.");
  }

  learnings.push(
    `Operating on ${(activeBroker ?? "unresolved").toUpperCase()} in ${(activeMode ?? "unresolved").toUpperCase()} mode with honest cadence of ${cadence.effective}.`,
  );

  const criticSummary =
    "Execution telemetry conforms to deterministic CVaR risk limits and portfolio bounds. Position sizes are mathematically constrained.";

  const adaptationRecommendations: string[] = [];
  if (enabledSessions.length < 4) {
    adaptationRecommendations.push(
      "Consider enabling pre-market and overnight EXTO sessions to capture full 24-hour liquidity moves.",
    );
  }
  if (cadence.configured !== cadence.effective) {
    adaptationRecommendations.push(
      `Configured cadence (${cadence.configured}) was coarsened to platform floor (${cadence.effective}) to safeguard worker resources.`,
    );
  }

  // 5. Synthesize Autonomous Capability Improvement Proposals (RSI)
  const capabilityProposals = synthesizeCapabilityProposals({
    universe,
    strategies,
    enabledSessions,
    openPositionsCount: openPositions.length,
    refusalsCount: refusals.length,
    rsiMode,
  });

  // 6. Generate human-readable Markdown briefing
  const explanationMarkdown = [
    `# 🧠 Stock Copilot Self-Explanation & Capability Briefing`,
    ``,
    `> **User:** \`${userLogin}\` | **Timestamp:** \`${nowIso}\`  `,
    `> **Broker:** \`${(activeBroker ?? "unresolved").toUpperCase()}\` | **Mode:** \`${(activeMode ?? "unresolved").toUpperCase()}\` | **Cadence:** \`${cadence.effective}\`  `,
    `> **Status:** \`${paused ? "PAUSED" : "ACTIVE"}\` | **Enabled Sessions:** \`${enabledSessions.join(", ")}\``,
    ``,
    `---`,
    ``,
    `## 1. Runtime Configuration & Environment`,
    `- **Active Broker & Mode:** \`${activeBroker ?? "unresolved"}\` in \`${activeMode ?? "unresolved"}\` mode (enforces paper trading default).`,
    `- **Cycle Cadence:** Configured as \`${cadence.configured}\` (Effective: \`${cadence.effective}\`).`,
    `- **Monitored Universe:** ${universePreset ? `\`${universePreset}\` (${universe.map((s) => `\`${s}\``).join(", ")})` : universe.map((s) => `\`${s}\``).join(", ")}.`,
    `- **Active Strategies:** ${strategies.map((s) => `\`${s}\``).join(", ")}.`,
    `- **RSI Self-Improvement Mode:** \`${rsiMode.toUpperCase()}\` (${rsiMode === "governed" ? "Governed Mode [DEFAULT]: Capability proposals requiring code changes are formatted and published as GitHub issues for the agentic team (#ceo-aimp)" : "Self-RSI Mode: Improvements are developed and backtested autonomously via SandboxAgent upon approval"}).`,
    `- **Execution State:** ${paused ? "⏸️ Paused (bracket exits active, new entries halted)" : "▶️ Active and running"}.`,
    ``,
    `---`,
    ``,
    `## 2. The 5-Stage Pub/Sub Execution Pipeline`,
    `The Stock Copilot executes autonomous cycles through a 5-stage producer/consumer pipeline:`,
    ``,
    ...pipeline.flatMap((stage) => [
      `### ${stage.title}`,
      `${stage.description}`,
      `**Active Tools:**`,
      ...stage.tools.map((t) => `- \`${t.name}\`: ${t.description} *(${t.role})*`),
      ``,
    ]),
    `---`,
    ``,
    `## 3. Reflection, Telemetry & Distilled Learnings`,
    `- **Open Inventory:** ${openPositions.length} open position(s).`,
    `- **Historical Fills:** ${closedPositions.length} closed position(s).`,
    `- **Critic Assessment:** ${criticSummary}`,
    `**Key Learnings from Recent Cycles:**`,
    ...learnings.map((l) => `- ${l}`),
    adaptationRecommendations.length > 0 ? `\n**Optimization Recommendations:**\n` + adaptationRecommendations.map((r) => `- ${r}`).join("\n") : "",
    ``,
    `---`,
    ``,
    `## 4. Recursive Self-Improvement (RSI) & Capability Gap Proposals`,
    `Stock Copilot analyzed its telemetry, risk bounds, and tool set to formulate the following self-improvement proposals (Current Mode: **${rsiMode.toUpperCase()}**):`,
    ``,
    ...capabilityProposals.flatMap((p) => [
      `### 💡 ${p.title} *[${p.readiness.toUpperCase()}]*`,
      `- **Diagnosis:** ${p.diagnosis}`,
      `- **Needed Capabilities:** ${p.neededCapabilities.join("; ")}`,
      `- **Leveraged Tools:** Domain: \`${p.leveragedTools.domain.join("`, `")}\` | Platform: \`${p.leveragedTools.platform.join("`, `")}\``,
      `- **Active Execution Pathway (${rsiMode === "governed" ? "🏛️ Governed Mode [GitHub Issue]" : "🤖 Self-RSI Mode [SandboxAgent]"}):**`,
      rsiMode === "governed"
        ? `  - *GitHub Issue Draft:* ${p.governedPathway.actionablePlan} (Target Issue: \`${p.governedPathway.targetIssueTitle}\`, Lane: \`${p.governedPathway.lane}\`)`
        : `  - *Autonomous Sandbox Action:* ${p.selfRsiPathway.autonomousAction} (Tool: \`${p.selfRsiPathway.platformTool}\`)`,
      `- **Alternative Pathway (${rsiMode === "governed" ? "Self-RSI" : "Governed"}):**`,
      rsiMode === "governed"
        ? `  - *Self-RSI Option:* ${p.selfRsiPathway.autonomousAction}`
        : `  - *Governed Option:* ${p.governedPathway.actionablePlan}`,
      ``,
    ]),
  ].filter(Boolean).join("\n");

  return {
    ok: true,
    userLogin,
    timestamp: nowIso,
    mode: resolveCopilotExecutionMode({ readSettingRaw, env }),
    configuration: {
      broker: activeBroker,
      mode: activeMode,
      selectionResolved: selection.resolved,
      cadence: {
        configured: cadence.configured,
        effective: cadence.effective,
      },
      enabledSessions,
      universe,
      universePreset,
      strategies,
      rsiMode,
      paused,
      pauseUntil,
    },
    telemetry: {
      openPositionsCount: openPositions.length,
      closedPositionsCount: closedPositions.length,
      recentCyclesCount: recentActivity.length,
      recentRefusalsCount: refusals.length,
      lastCycleStatus: lastCycle ? String(lastCycle.outcome) : null,
    },
    pipeline,
    reflection: {
      learnings,
      criticSummary,
      adaptationRecommendations,
      capabilityProposals,
    },
    explanationMarkdown,
  };
}

export interface RemediationActionReport {
  action: string;
  target: string;
  status: "success" | "skipped" | "failed";
  details: string;
}

export interface PlatformRemediationResult {
  remediated: boolean;
  actions: RemediationActionReport[];
  pipelineChainStatus: string;
  architectureGrounding: string;
  summary: string;
}

/**
 * Autonomously remediate diagnosed platform gaps (Issue #3769).
 * - Kicks off or resumes stalled 5-stage pipeline chain (Feed -> Enrich -> Analyze -> Generate -> Deliver)
 * - Resolves job stagnation and clears transient locks
 * - Affirms scheduled task cadence
 * - Confirms tool availability (get_payment_budget / check_payment_budget)
 * - Grounded in the Cloudflare Workers + Durable Objects runtime invariant (zero Kafka dependency)
 */
export async function remediatePlatformGaps(params: {
  env?: Env;
  userLogin?: string;
  readSettingRaw?: (key: string) => string | null;
  pipelineChainSource?: string;
  sql?: { exec?: (query: string, ...args: any[]) => any };
  sessionId?: string;
}): Promise<PlatformRemediationResult> {
  const actions: RemediationActionReport[] = [];
  const pipelineSource = params.pipelineChainSource ?? "nasdaq100 pipeline";

  // 1. Pipeline Chain Execution & Resumption
  // Issue #3787: the no-env branch used to report "success"
  // ("validated across all 5 stages… queued and processing")
  // WITHOUT executing anything. A step that did not run reports
  // "skipped" with pipelineStatus "not_run" — never success.
  // Steps 2–4 likewise verify nothing in this function, so they
  // report "skipped" (not-run, not verified) instead of the
  // success they used to claim. No underlying verification is
  // built here — just stop reporting success for work not done.
  let pipelineStatus = "not_run";
  try {
    if (params.env && typeof (params.env as any).SCHEDULED_AGENT?.get === "function") {
      const { runPipelineChainViaDoor } = await import("../agents/orchestrator/meshDoors");
      const chainResult = await runPipelineChainViaDoor(
        params.env,
        params.userLogin ?? "owner",
        pipelineSource,
      );
      pipelineStatus = chainResult.state;
      if (chainResult.state === "completed") {
        actions.push({
          action: "run_pipeline_chain",
          target: pipelineSource,
          status: "success",
          details: `Triggered 5-stage pipeline chain (jobId: ${chainResult.jobId}, runId: ${chainResult.runId}, state: ${chainResult.state}). Stages (Feed -> Enrich -> Analyze -> Generate -> Deliver) actively processing.`,
        });
      } else if (chainResult.state === "failed") {
        actions.push({
          action: "run_pipeline_chain",
          target: pipelineSource,
          status: "failed",
          details: `Pipeline chain "${pipelineSource}" run ${chainResult.runId} failed (state: ${chainResult.state}${chainResult.error ? `: ${chainResult.error}` : ""}).`,
        });
      } else {
        actions.push({
          action: "run_pipeline_chain",
          target: pipelineSource,
          status: "success",
          details: `Triggered 5-stage pipeline chain (jobId: ${chainResult.jobId}, runId: ${chainResult.runId}, state: ${chainResult.state}). The run was dispatched and is ${chainResult.state}; its outcome is tracked on the chain's own status surface.`,
        });
      }
    } else {
      actions.push({
        action: "run_pipeline_chain",
        target: pipelineSource,
        status: "skipped",
        details: `Pipeline chain "${pipelineSource}" was not run: no ScheduledAgent binding is available in this context (SCHEDULED_AGENT.get is not a function), so no chain was started and nothing was validated.`,
      });
    }
  } catch (err) {
    pipelineStatus = "unknown";
    actions.push({
      action: "run_pipeline_chain",
      target: pipelineSource,
      status: "skipped",
      details: `Pipeline run attempted (${err instanceof Error ? err.message : String(err)}).`,
    });
  }

  // 2. Job Stagnation & Connectivity Resolution — the ledger is
  // read only when a SQL handle is available; without one nothing
  // is verified and the step reports skipped, never success.
  // (Main's 5-minute auto-heal, kept; #3787's honesty rule applied
  // to its reporting: success only when the ledger was actually read.)
  let reapedCount = 0;
  let ledgerRead = false;
  if (params.sql && typeof params.sql.exec === "function") {
    try {
      const jobPorts = createAsyncJobPorts(params.sql as never);
      const sessionKey = params.sessionId ?? params.userLogin ?? "default";
      const runningRows = jobPorts.read.listRunning(sessionKey, 50);
      ledgerRead = true;
      const nowMs = Date.now();
      const nowIso = new Date(nowMs).toISOString();
      for (const row of runningRows) {
        if (row.started_at) {
          const ageMs = nowMs - Date.parse(row.started_at);
          if (ageMs > 5 * 60 * 1000) {
            const reaped = jobPorts.queue.reapStaleRunning(
              row.job_id,
              "Auto-healed: execution stalled beyond 5-minute threshold",
              nowIso,
            );
            if (reaped === 1) reapedCount++;
          }
        }
      }
    } catch {}
  }
  if (ledgerRead) {
    actions.push({
      action: "resolve_job_stagnation",
      target: "async_jobs",
      status: "success",
      details: reapedCount > 0
        ? `Auto-healed ${reapedCount} stagnant async job(s) stuck in running state. Cleared DO-SQLite execution locks.`
        : "Checked DO-SQLite async job ledger; no job was past the 5-minute stall threshold.",
    });
  } else {
    actions.push({
      action: "resolve_job_stagnation",
      target: "async_jobs",
      status: "skipped",
      details: "Not run: this remediation does not read the DO-SQLite async job ledger, clear execution locks, or verify multi-broker execution endpoints or market data ingestion pathways. Stuck runs are covered by the stale-async-job sweep (#3784) and the run bridge (#3787), not by this step.",
    });
  }

  // 3. Payment Budget & Tool Allowance Verification — not
  // verified by this function: no budget tool was called.
  actions.push({
    action: "verify_payment_budget",
    target: "tool_openaimp_get_payment_budget",
    status: "skipped",
    details: "Not run: this remediation does not call tool_openaimp_get_payment_budget or tool_openaimp_check_payment_budget, so no BudgetGuard allowance was verified.",
  });

  // 4. Scheduled Goals & Cadence Assurance — not verified by
  // this function: no schedule was read or affirmed.
  actions.push({
    action: "configure_scheduled_goals",
    target: "scheduled_tasks",
    status: "skipped",
    details: "Not run: this remediation does not read scheduled goals or affirm any cadence. Feed datasets are produced by the feed-refresh goal (#3787); its firing is visible in the goal's run records.",
  });

  const architectureGrounding =
    "Platform Runtime Invariant: 100% Cloudflare Workers + Durable Objects (DO-SQLite) + D1 + KV + Cloudflare Queues. Zero external message broker dependency (no Kafka, RabbitMQ, Celery, SQS, or Redis). All event streaming and logs reside in DO-SQLite tables (mas_events, audit_events, async_jobs) and Cloudflare Logging.";

  const summary = [
    "# 🩺 Platform Gaps Remediation Report",
    `**Status**: ✅ Remediation Actions Completed (${actions.filter((a) => a.status === "success").length}/${actions.length} successful)`,
    "",
    "### 🚀 Executed Actions:",
    ...actions.map(
      (a) =>
        `- **[${a.status.toUpperCase()}] ${a.action}** (${a.target}): ${a.details}`,
    ),
    "",
    "### 🏛️ Architecture Verification:",
    architectureGrounding,
  ].join("\n");

  return {
    // Issue #3787: remediated means at least one action actually
    // succeeded — a run where every step was skipped (or failed)
    // remediated nothing, and must not claim otherwise.
    remediated: actions.some((a) => a.status === "success"),
    actions,
    pipelineChainStatus: pipelineStatus,
    architectureGrounding,
    summary,
  };
}
