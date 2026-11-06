/**
 * PR #2 — A2A agent cards.
 *
 * Served at /.well-known/agent-card.json. Each card describes an
 * agent's capabilities so external A2A callers can discover and
 * invoke them via /a2a/<agent> endpoints.
 */

export interface AgentCard {
  name: string;
  description: string;
  version: string;
  /** A2A endpoint path, e.g. "/a2a/orchestrator" */
  endpoint: string;
  /** Discovery path for this agent's card */
  cardPath: string;
  capabilities: string[];
  /** Operations this agent exposes (subset of orchestrate.ts catalog) */
  operations: string[];
}

export const AGENT_CARDS: AgentCard[] = [
  {
    name: "orchestrator",
    description: "Plans and supervises multi-step agent workflows",
    version: "1.0.0",
    endpoint: "/a2a/orchestrator",
    cardPath: "/a2a/orchestrator/agent-card.json",
    capabilities: ["planning", "supervision", "parallel-execution"],
    operations: ["search.query", "payments.draft", "payments.confirm", "tasks.create", "memory.remember", "memory.recall", "nlq.execute"],
  },
  {
    name: "search",
    description: "Web and data search agent",
    version: "1.0.0",
    endpoint: "/a2a/search",
    cardPath: "/a2a/search/agent-card.json",
    capabilities: ["web-search", "opportunity-hunt"],
    operations: ["search.query"],
  },
  {
    name: "payments",
    description: "x402 payment processing with budget guards",
    version: "1.0.0",
    endpoint: "/a2a/payments",
    cardPath: "/a2a/payments/agent-card.json",
    capabilities: ["budget-check", "payment-process", "payment-list"],
    operations: ["payments.budget_check", "payments.today_spent", "payments.list", "payments.process"],
  },
  {
    name: "tasks",
    description: "Task tracking and management",
    version: "1.0.0",
    endpoint: "/a2a/tasks",
    cardPath: "/a2a/tasks/agent-card.json",
    capabilities: ["task-create", "task-list", "task-update"],
    operations: ["tasks.create"],
  },
  {
    name: "memory",
    description: "Long-term vector memory for agent outcomes",
    version: "1.0.0",
    endpoint: "/a2a/memory",
    cardPath: "/a2a/memory/agent-card.json",
    capabilities: ["remember", "recall"],
    operations: ["memory.remember", "memory.recall"],
  },
  {
    name: "trading",
    description:
      "Provider-neutral trading competency: screening and (approval-gated) trading across registered broker providers",
    version: "1.0.0",
    endpoint: "/a2a/trading",
    cardPath: "/a2a/trading/agent-card.json",
    capabilities: ["stock-screening", "options-screening", "stock-trading", "options-trading"],
    operations: ["trading.screen_stocks", "trading.screen_options", "trading.trade_stock", "trading.trade_options"],
  },
  {
    name: "aisearch",
    description:
      "Searches the Cloudflare AI Search knowledge instance two ways, in priority order: the namespace binding (agent tool, primary) and the instance's public MCP endpoint (second). Answers are labelled with the serving path and degrade honestly — an unconfigured path is skipped and fallback-labelled content is never served as live results.",
    version: "1.0.0",
    endpoint: "/a2a/aisearch",
    cardPath: "/a2a/aisearch/agent-card.json",
    capabilities: ["knowledge-search"],
    operations: ["aisearch.search"],
  },
  {
    name: "screener",
    description:
      "Runs stock and goal-driven screens on the screener's service instance. Runs are attributed to the configured service identity; with none configured the door fails closed rather than starting a virgin instance.",
    version: "1.0.0",
    endpoint: "/a2a/screener",
    cardPath: "/a2a/screener/agent-card.json",
    capabilities: ["stock-screening", "goal-screening", "run-history"],
    operations: ["screener.run_screen", "screener.run_goal_screen", "screener.latest", "screener.history", "screener.list_tasks"],
  },
  {
    name: "scheduled",
    description:
      "The live scheduled-goal catalogue: list, add, remove, enable/disable, and trigger goals on the instance the cron actually fires. (Cron firing itself is not an A2A operation.)",
    version: "1.0.0",
    endpoint: "/a2a/scheduled",
    cardPath: "/a2a/scheduled/agent-card.json",
    capabilities: ["goal-list", "goal-manage", "goal-trigger", "tick-history"],
    operations: ["scheduled.list_goals", "scheduled.tick_history", "scheduled.add_goal", "scheduled.remove_goal", "scheduled.set_goal_enabled", "scheduled.trigger_goal"],
  },
  {
    name: "research",
    description:
      "Runs the research pipeline and discovery on the service identity's research instance, and reads its latest report, history, track record, evaluations, and configuration. Runs are attributed to the configured service identity and fail closed without one.",
    version: "1.0.0",
    endpoint: "/a2a/research",
    cardPath: "/a2a/research/agent-card.json",
    capabilities: ["research-runs", "discovery", "track-record", "evaluation"],
    operations: ["research.run", "research.discovery", "research.latest", "research.history", "research.track_record", "research.evaluate", "research.config"],
  },
  {
    name: "report-asset",
    description:
      "Generates and fetches PDF report assets through the single generate-step owner. Fetched assets return as metadata plus base64 bytes; generation is scoped to the configured service identity.",
    version: "1.0.0",
    endpoint: "/a2a/report-asset",
    cardPath: "/a2a/report-asset/agent-card.json",
    capabilities: ["pdf-generation", "asset-fetch"],
    operations: ["report_asset.generate", "report_asset.get", "report_asset.list"],
  },
  {
    name: "browser",
    description:
      "Captures transaction and page snapshots for Slack delivery and scrapes rendered page tables. Delivery goes only to env-configured destinations — a caller-supplied webhook is never honored.",
    version: "1.0.0",
    endpoint: "/a2a/browser",
    cardPath: "/a2a/browser/agent-card.json",
    capabilities: ["transaction-snap", "page-snapshot", "dom-scraping"],
    operations: ["browser.snap_transaction", "browser.capture_page", "browser.scrape_tables"],
  },
  {
    name: "slack",
    description:
      "Dispatches pre-trade approval tickets (the human-in-the-loop gate) and transaction snapshots to the configured Slack destination through SlackAgent's two helpers. Slack event/command ingress is not served here — it stays behind the worker routes with its signature gate.",
    version: "1.0.0",
    endpoint: "/a2a/slack",
    cardPath: "/a2a/slack/agent-card.json",
    capabilities: ["pre-trade-approval", "transaction-snap"],
    operations: ["slack.send_pre_trade_approval", "slack.dispatch_transaction_snap"],
  },
  {
    name: "sandbox",
    description:
      "Reports the sandbox's backend status and runs shell commands through SandboxAgent's one service (ETradeSandboxService). Honestly degraded in this deployment: no container backend is bound, so run_command returns executed:false with exitCode:null and no fabricated output until an owner binds one — check sandbox.status first.",
    version: "1.0.0",
    endpoint: "/a2a/sandbox",
    cardPath: "/a2a/sandbox/agent-card.json",
    capabilities: ["sandbox-status", "sandbox-run"],
    operations: ["sandbox.status", "sandbox.run_command"],
  },
];

/** Find a card by agent name. */
export function getAgentCard(name: string): AgentCard | undefined {
  return AGENT_CARDS.find((c) => c.name === name);
}

/** Alias for backwards compat with index.ts */
export const A2A_CARDS = AGENT_CARDS;

/** Standard A2A discovery paths */
export const A2A_CARD_PATHS = ["/.well-known/agent-card.json", "/.well-known/agent.json"];
