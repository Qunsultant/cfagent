/**
 * #2654 (Platform Phase 3, program #2468) — mesh-aligned access.
 *
 * One pure-derivation join between the Phase 2 catalog and the mesh
 * doors: for a catalog entry, which chat command starts its workflow,
 * which panel surface triggers it, which API endpoint gates it — and
 * whether those surfaces agree. This module reads NO store, opens no
 * session, and creates no table, flag, cron, or queue, so its #1819
 * rows-read impact is zero.
 *
 * Sources (exactly these, no hand-maintained second list):
 *   1. Phase 2 catalog entries (src/data/productCatalogue.ts, #2640):
 *      the product input — family, tier, canonical name, serving
 *      agent, gate endpoint, price, availability, requirements.
 *   2. Mesh registry (src/agents/registry.ts, #2225 S1/S15/S18):
 *      serving-agent registration + capability×door census + workflow
 *      bindings. READ ONLY here; the registry file is mesh-owned.
 *   3. Gate triple (TRADING_PAID_SERVICES, #2405 slices 1–5): the
 *      operative per-run price + endpoint for gated families.
 *   4. Operator price-catalogue rows (PriceEntry, #2012 #2185/#2189
 *      + #2547 approval), supplied by the caller: the chat paid
 *      stock screen reads the RAW stored price (see F3 below).
 *   5. Chat door commands (meshScreenDoor #2488, meshOptionsStrategyDoor
 *      #2581, agenticPaymentCommands paid_options_screener, G1 doors
 *      #2341/#2349/#2351) and panel surfaces (WorkflowsHub,
 *      ScreenersHub, AsyncJobsPanel/WorkflowRunsPanel).
 *
 * Parity is judged PER DIMENSION (agent, gate, price, operation) with
 * values + notes. Overall "parity" holds only when every dimension
 * agrees; otherwise "divergent" with named dimensions. Divergences
 * are pinned by tests, never smoothed over. Findings (full audit in
 * ~/workspace/cfagent-platform-p3-notes/PHASE3-INVENTORY.md):
 *   F1 options×PayPerUse PARITY: chat paid_options_screener uses the
 *      OPTIONS_SCREENER x402 gate ($0.05) and returns exactly the
 *      REST options-scan envelope.
 *   F2 stock×PayPerUse DIVERGENT: API = anomaly signals via x402;
 *      chat = universe screen via ScreenerScreenWorkflow; panel =
 *      provider endpoints. One family label, three mechanisms.
 *   F3 stock chat paid price = RAW operator catalogue price
 *      (defaultPaidScreenPriceUSD → adapter.getPrice, NOT
 *      getApprovedPrice): #2547 approval discipline is NOT honored
 *      on the door path (nor the NLQ port seam). Latent while the
 *      monetization flag is OFF (default). Follow-up for the
 *      monetization lane; this phase changes NOTHING charged.
 *   F4 dual-card: capability string "stock-screening" is claimed by
 *      both cards; resolution is BY OPERATION (see
 *      resolveStockScreeningPrimary). AGENT_CARDS is mesh-owned and
 *      is NOT edited here.
 *   F5 options strategy door is INLINE (durable=false, no workflow/
 *      job); the PayPerUse route is the envelope-parity path.
 *   F6 goal UNLISTED: chat reachability = trigger_scheduled_goal +
 *      A2A run_goal_screen (ungated); no gate, no price.
 *   F7 serving card ≠ workflow: options card "trading" does NOT mean
 *      TradingTradeWorkflow (trade execution stays approval-gated,
 *      never monetized). Card and workflow are named separately.
 */

import { TRADING_PAID_SERVICES } from "../services/agenticPayments";
import type { PriceEntry, PriceFamily } from "./priceCataloguePorts";
import type { ProductEntry, ProductTier } from "./productCatalogue";

export interface ChatFreeForm {
  command: string;
  doorService: string;
  durable: boolean;
  note: string;
}

export interface ChatRoute {
  command: string;
  doorService: string;
  servingAgent: string;
  workflow: string | null;
  workflowBinding: string | null;
  /** true = durable workflow run; "route-level" = no separate job. */
  durable: boolean | "route-level";
  paidPath: string;
  paidPriceSource: string;
  /** Whether the chat operation is the same operation the API serves. */
  apiOperationAgrees: boolean;
  operationNote: string;
  freeForm?: ChatFreeForm;
}

export const PRODUCT_CHAT_ROUTES: Record<PriceFamily, ChatRoute | null> = {
  stock: {
    command: "run_stock_screen",
    doorService:
      "runStockScreenViaDoor (src/agents/orchestrator/meshScreenDoor.ts, #2488)",
    servingAgent: "screener",
    workflow: "ScreenerScreenWorkflow",
    workflowBinding: "SCREENER_WORKFLOW",
    durable: true,
    paidPath: "PaymentWorkflow budget path (one charge per run-request)",
    paidPriceSource: "operator catalogue (raw, no approval check)",
    apiOperationAgrees: false,
    operationNote:
      "chat runs the universe screen (ScreenerScreenWorkflow); the API serves anomaly signals — different operations under one family label",
  },
  options: {
    command: "paid_options_screener",
    doorService:
      "agenticPaymentCommands (x402 OPTIONS_SCREENER gate, rest mode returns the REST envelope)",
    servingAgent: "trading",
    workflow: null,
    workflowBinding: null,
    durable: "route-level",
    paidPath: "x402 OPTIONS_SCREENER gate",
    paidPriceSource: "gate (TRADING_PAID_SERVICES)",
    apiOperationAgrees: true,
    operationNote:
      "chat paid command returns exactly the REST options-scan envelope",
    freeForm: {
      command: "run_options_strategy_screen",
      doorService:
        "runOptionsStrategyScreenViaDoor (src/agents/orchestrator/meshOptionsStrategyDoor.ts, #2581)",
      durable: false,
      note: "inline scan via the runOptionsStrategyAction seam; no workflow/job",
    },
  },
  goal: null,
  strategy: null,
};

/** Goal has no purchasable chat route; this is its honest reachability. */
export const GOAL_CHAT_REACHABILITY =
  "trigger_scheduled_goal (scheduled runs via the ScheduledAgent door) + " +
  "screener.run_goal_screen (A2A, ungated); no purchasable chat route";

export interface PanelSurface {
  trigger: string | null;
  triggerNote?: string;
  runStatusSurface: string;
}

const RUN_STATUS_SURFACE = "AsyncJobsPanel / WorkflowRunsPanel";

export const PRODUCT_PANEL_SURFACES: Record<PriceFamily, PanelSurface> = {
  stock: {
    trigger:
      "provider endpointByAssetClass (ScreenersHub — provider-dependent, not the gated endpoint)",
    runStatusSurface: RUN_STATUS_SURFACE,
  },
  options: {
    trigger:
      "POST /api/trading/options/screen + POST /api/premium/options-scan (WorkflowsHub)",
    runStatusSurface: RUN_STATUS_SURFACE,
  },
  goal: {
    trigger: null,
    triggerNote: "scheduled-goal catalogue surface only; no purchasable trigger",
    runStatusSurface: RUN_STATUS_SURFACE,
  },
  strategy: {
    trigger: null,
    triggerNote: "no serving card; no panel trigger",
    runStatusSurface: RUN_STATUS_SURFACE,
  },
};

export interface ChatSurface {
  command: string;
  doorService: string;
  workflow: string | null;
  workflowBinding: string | null;
  durable: boolean | "route-level";
  paidPath: string;
  paidPriceSource: string;
  freeForm?: ChatFreeForm;
}

export interface ApiSurface {
  gateEndpoint: string | null;
  priceUSD: number | null;
  priceSource: "gate" | "catalogue-approved" | null;
}

export type DimensionVerdictValue = "agree" | "divergent" | "not-applicable";

export interface DimensionVerdict {
  verdict: DimensionVerdictValue;
  note: string;
}

export interface ProductAccess {
  id: string;
  family: PriceFamily;
  tier: ProductTier;
  canonicalName: string;
  servingAgent: string | null;
  workflow: string | null;
  routable: boolean;
  nonRoutableReasons: string[];
  chat: ChatSurface | null;
  chatReachabilityNote: string | null;
  panel: PanelSurface;
  api: ApiSurface;
  parity: {
    verdict: "parity" | "divergent" | "not-routable";
    dimensions: {
      agent: DimensionVerdict;
      gate: DimensionVerdict;
      price: DimensionVerdict;
      operation: DimensionVerdict;
    };
    notes: string[];
  };
}

/**
 * Dual-card resolution (F4). The capability string "stock-screening"
 * is claimed by both cards, but the operations differ in kind:
 * trading.screen_stocks is a provider market scan (read-only, no
 * workflow, no report, no receipt path) present on the A2A door
 * only; screener.run_screen is the engine run (recorded, workflow
 * via the chat door, canonical report, metered receipt when gated).
 * The catalog stock product routes BY OPERATION to screener. The
 * duplicate capability string is a mesh-lane follow-up (disambiguate
 * upstream); it is not edited here because AGENT_CARDS is mesh-owned.
 */
export function resolveStockScreeningPrimary(): {
  primary: string;
  primaryOperation: string;
  alternateOperation: string;
  alternateKind: string;
  routingRule: string;
  meshFollowUp: string;
} {
  return {
    primary: "screener",
    primaryOperation: "screener.run_screen",
    alternateOperation: "trading.screen_stocks",
    alternateKind:
      "provider market scan via platform.screenMarkets (read-only, no workflow/report/receipt)",
    routingRule:
      "route by operation (run_screen / run_stock_screen), never by capability string",
    meshFollowUp:
      "disambiguate the duplicated capability string upstream (mesh lane); AGENT_CARDS untouched here",
  };
}

function notApplicable(note: string): DimensionVerdict {
  return { verdict: "not-applicable", note };
}

export function resolveProductAccess(
  entry: ProductEntry,
  catalogueEntries: PriceEntry[],
): ProductAccess {
  const panel = PRODUCT_PANEL_SURFACES[entry.family];
  const api: ApiSurface = {
    gateEndpoint: entry.gateEndpoint,
    priceUSD: entry.priceUSD,
    priceSource: entry.priceSource,
  };
  const base = {
    id: entry.id,
    family: entry.family,
    tier: entry.tier,
    canonicalName: entry.canonicalName,
    servingAgent: entry.servingAgent,
    panel,
    api,
  };
  if (!entry.listed) {
    return {
      ...base,
      workflow: null,
      routable: false,
      nonRoutableReasons: [...entry.unlistedReasons],
      chat: null,
      chatReachabilityNote:
        entry.family === "goal" ? GOAL_CHAT_REACHABILITY : null,
      parity: {
        verdict: "not-routable",
        dimensions: {
          agent: notApplicable("product is not routable"),
          gate: notApplicable("product is not routable"),
          price: notApplicable("product is not routable"),
          operation: notApplicable("product is not routable"),
        },
        notes: [],
      },
    };
  }
  const route = PRODUCT_CHAT_ROUTES[entry.family];
  if (route === null || entry.servingAgent === null) {
    // A listed product without a chat route is a catalog/gate bug, not
    // a shape to paper over: fail closed as non-routable with a reason.
    return {
      ...base,
      workflow: null,
      routable: false,
      nonRoutableReasons: [
        ...entry.unlistedReasons,
        "listed product has no chat route — refusing rather than inventing one",
      ],
      chat: null,
      chatReachabilityNote: null,
      parity: {
        verdict: "not-routable",
        dimensions: {
          agent: notApplicable("no chat route"),
          gate: notApplicable("no chat route"),
          price: notApplicable("no chat route"),
          operation: notApplicable("no chat route"),
        },
        notes: [],
      },
    };
  }
  const chat: ChatSurface = {
    command: route.command,
    doorService: route.doorService,
    workflow: route.workflow,
    workflowBinding: route.workflowBinding,
    durable: route.durable,
    paidPath: route.paidPath,
    paidPriceSource: route.paidPriceSource,
    ...(route.freeForm ? { freeForm: route.freeForm } : {}),
  };
  const agent: DimensionVerdict =
    route.servingAgent === entry.servingAgent
      ? {
          verdict: "agree",
          note: "chat door serves the catalog serving agent",
        }
      : {
          verdict: "divergent",
          note: `chat door serves ${route.servingAgent}, catalog names ${entry.servingAgent}`,
        };
  const gate: DimensionVerdict =
    route.paidPriceSource.startsWith("gate")
      ? {
          verdict: "agree",
          note: "chat paid path uses the same x402 gate as the API route",
        }
      : {
          verdict: "divergent",
          note:
            "chat paid path is the PaymentWorkflow budget path, not the x402 gate the API route enforces",
        };
  // Chat paid price: options charges the gate price; stock charges
  // the RAW operator catalogue price (F3 — no approval check).
  const rawStockRow = catalogueEntries.find((e) => e.family === "stock");
  const rawStockPrice =
    typeof rawStockRow?.priceUSD === "number" ? rawStockRow.priceUSD : null;
  const chatPaidPrice =
    entry.family === "stock"
      ? rawStockPrice
      : TRADING_PAID_SERVICES.OPTIONS_SCREENER.priceUSD;
  let price: DimensionVerdict;
  if (chatPaidPrice === null) {
    price = {
      verdict: "divergent",
      note:
        "no stored catalogue price — chat paid path fails closed while the API gate price stands",
    };
  } else if (entry.priceUSD !== null && chatPaidPrice === entry.priceUSD) {
    price =
      entry.family === "stock"
        ? {
            verdict: "agree",
            note:
              "values agree as seeded; sources differ (raw operator catalogue vs gate constant) — an operator price change diverges them",
          }
        : {
            verdict: "agree",
            note: "chat and API both charge the gate price",
          };
  } else {
    price = {
      verdict: "divergent",
      note: `chat paid price $${chatPaidPrice} ≠ gate price $${entry.priceUSD}`,
    };
  }
  const operation: DimensionVerdict = route.apiOperationAgrees
    ? { verdict: "agree", note: route.operationNote }
    : { verdict: "divergent", note: route.operationNote };
  const notes: string[] = [];
  if (entry.family === "stock") {
    notes.push(
      "F3 (#2547 gap, latent while the monetization flag is OFF): the " +
        "stock chat paid path reads the raw operator catalogue price and " +
        "honors no approval state, while HTTP gates fail closed on " +
        "PROPOSED prices. Follow-up for the monetization lane: align " +
        "door + NLQ paid price sources to getApprovedPrice. This phase " +
        "changes nothing charged.",
    );
  }
  if (route.freeForm) {
    notes.push(
      `Free-form chat path ${route.freeForm.command} is inline (${route.freeForm.note}); ` +
        "the PayPerUse route is the envelope-parity path, not the free-form door.",
    );
  }
  const allAgree = [agent, gate, price, operation].every(
    (d) => d.verdict === "agree",
  );
  return {
    ...base,
    workflow: route.workflow,
    routable: true,
    nonRoutableReasons: [],
    chat,
    chatReachabilityNote: null,
    parity: {
      verdict: allAgree ? "parity" : "divergent",
      dimensions: { agent, gate, price, operation },
      notes,
    },
  };
}
