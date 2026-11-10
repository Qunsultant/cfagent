/**
 * Issue #3232 (program #3216): the broker catalog — one source of truth for
 * which brokers exist, what each one can do, and what each platform
 * environment means as a *trading type*.
 *
 * Why this module exists: the platform seam was broker-neutral in intent but
 * named one broker in fact. `TradingPlatformId` listed "sandbox" — an
 * environment — beside brokers; `ROUTED_BROKERS` in the routed-order route was
 * a second, hand-maintained copy of the broker list; and the Alpaca platform
 * reported `protocol: "etrade_oauth_rest"`, i.e. one broker's protocol as if it
 * were the platform's. Every one of those is the same defect: a broker-shaped
 * fact living outside a broker definition.
 *
 * This module is deliberately data + pure functions (15-factor: config lives
 * in the environment, code holds defaults, nothing here reads the world at
 * import). Adding a broker means adding one entry — the acceptance for the
 * program's "no edits to shared paths" goal.
 *
 * Vocabulary, fixed here so the rest of the tree can stop inventing it:
 *   - BrokerId          which firm executes (etrade, alpaca, public) — never an environment.
 *   - TradingEnvironment the platform's environment token (TEST, PROD) — what
 *                       existing routes and settings already carry.
 *   - TradingType       what the user is doing (paper, live) — the user-facing
 *                       answer to "type of trading", mapped per broker.
 */

/** Brokers with a registered `ITradingPlatform`. Never an environment. */
export type BrokerId = "etrade" | "alpaca" | "public";

/** The platform environment token carried by routes/settings today. */
export type TradingEnvironment = "TEST" | "PROD";

/** What the user is actually doing. `paper` is first-class, not an inference. */
export type TradingType = "paper" | "live";

/** How this broker authenticates. Each kind has exactly one seam (#2755). */
export type BrokerCredentialKind = "oauth1_per_login" | "api_key_pair" | "personal_token";

/** Asset classes the platform can route orders for. */
export type BrokerAssetClass = "equity" | "options";

/**
 * The operations a broker can actually perform (#3233). Declared per broker so
 * callers and surfaces can say "Alpaca does not offer this" instead of showing
 * an empty panel, and so a missing method is a stated fact rather than a bug
 * discovered at execution time.
 */
export type BrokerOperation =
  | "quote"
  | "detailedQuote"
  | "accounts"
  | "positions"
  | "positionLots"
  | "optionChains"
  | "optionExpireDates"
  // Issue #3296 declared portfolio risk; issue #3324 made it true for every
  // broker. The model is the platform's (`PortfolioRiskSource`), and each
  // broker supplies its own book, chains, and spot price — so a report never
  // mixes brokers, and "no model for this broker" is no longer a state.
  | "portfolioRisk"
  // Issue #3295: saved strategy profiles and scan history. The scan ENGINE is
  // broker-neutral (it runs on OptionChainSource, #3272), but the #28/#27
  // stores hold E*TRADE rows, so the scanner surface has no neutral backend
  // yet. Declared rather than silently routed to E*TRADE.
  | "optionsScanner"
  // Issue #3292 declared IV history; issue #3326 made it true for every broker
  // by recording provenance. One observation per (symbol, date) remains — the
  // day has one value — and each row names the broker whose chain measured it,
  // so a series is only ever served under the broker that produced it. No
  // broker is asked to expose an IV-history endpoint, and no series is derived
  // from a single snapshot.
  | "ivHistory"
  | "orderPreview"
  | "orderPlace"
  | "marketScreening"
  // Issue #3359: the account-history reads. Declared for the same reason as
  // every other operation: an Alpaca tenant looking at their account must see
  // either their own activity or a sentence naming what the broker lacks --
  // never an empty table that reads like "you did nothing today".
  | "orderHistory"
  | "accountActivity"
  | "alerts"
  | "watchlists"
  // Issue #3390: cancelling a live order at the broker. Declared because the
  // neutral order routes must say "this broker cannot cancel" rather than
  // render a control that does nothing; both brokers implement it today.
  | "orderCancel"
  // Issue #3374: the persisted runs of the autonomous OPTIONS DISCOVERY engine
  // (#126/#18). Unlike the scanner (#3327), discovery has no neutral engine to
  // scope to: its production wiring builds ETrade chains
  // (`createDiscoveryService`). Declared so the run history names the gap
  // instead of serving E*TRADE-produced runs to another broker's tenant, and so
  // the declaration flips to true on the day a second source is wired.
  | "optionsDiscovery";

/**
 * Issue #3839: the copilot's per-broker capability, declared in the SAME
 * catalog as everything else. The copilot never hardcodes a broker: it
 * reads this block, so onboarding a broker is one catalog entry + one
 * registry registration. A broker that cannot quote, preview, or place is
 * declared unsupported here rather than failing at the first cycle.
 */
export interface BrokerCopilotCapability {
  /** The copilot may run on this broker at all. */
  readonly supported: boolean;
  /** The autonomous scheduled cycle may place orders on this broker. */
  readonly autonomousCycle: boolean;
  /**
   * Bracket support: `native` places TP/SL children at the broker,
   * `preview` produces a bracket DRAFT but placement is separate exit
   * orders, `none` has no bracket model.
   */
  readonly bracketOrders: "native" | "preview" | "none";
  /** Percent exits are accepted by preview/place for this broker. */
  readonly percentBrackets: boolean;
  /** The market-data provider the copilot uses for historical bars. */
  readonly barsProvider: "alpaca" | "yfinance" | "hybrid";
  /** The discovered MCP tool names (without the `tool_openaimp_` prefix). */
  readonly tools: {
    readonly quote: string;
    readonly preview: string;
    readonly place: string;
    readonly orders: string | null;
    readonly cancel: string | null;
  };
}

export interface BrokerDefinition {
  readonly id: BrokerId;
  readonly label: string;
  readonly credentialKind: BrokerCredentialKind;
  readonly assetClasses: readonly BrokerAssetClass[];
  /** Which operations this broker supports. Total by type: every op is stated. */
  readonly supports: Readonly<Record<BrokerOperation, boolean>>;
  /** Environment → trading type. Total by type: every environment must resolve. */
  readonly tradingTypeForEnvironment: Readonly<Record<TradingEnvironment, TradingType>>;
  /**
   * This broker's OWN status vocabulary. The status surface reports the
   * selected broker's words; a broker never reports another broker's protocol.
   */
  readonly statusVocabulary: {
    readonly protocol: BrokerProtocol;
    readonly mode: Readonly<Record<TradingType, BrokerStatusMode>>;
    readonly environment: Readonly<Record<TradingType, "paper" | "live">>;
  };
  /** Issue #3839: the copilot's declared capability on this broker. */
  readonly copilot: BrokerCopilotCapability;
}

/** Wire protocol strings, one per broker kind. Additive: existing values stay. */
export type BrokerProtocol = "etrade_oauth_rest" | "alpaca_rest_v2" | "mcp_json_rpc" | "sandbox_simulated";

/** Status mode strings, one per trading type per broker kind. */
export type BrokerStatusMode = "live_oauth" | "paper_api" | "live_api" | "mcp_remote" | "simulated_engine" | "sandbox_api";

/**
 * Issue #3330: what a connect surface must ask THIS broker for.
 *
 * The hub's connect flow was E*TRADE's OAuth redirect. Alpaca authenticates
 * with a key pair, so the surface has to branch — and it must branch on the
 * catalogue's declaration, not on a second list of brokers in the UI. Names are
 * the deployment's own (the `ALPACA_PAPER_*` / `ALPACA_LIVE_*` pairs), so the
 * instruction a user reads matches the secret they must set.
 */
export interface BrokerCredentialGuidance {
  readonly kind: BrokerCredentialKind;
  /** Environment variable names to set, per trading type. */
  readonly envNames: Readonly<Record<TradingType, readonly string[]>>;
  /** Sentence describing the sign-in this broker uses. */
  readonly summary: string;
}

const CREDENTIAL_GUIDANCE: Readonly<Record<BrokerId, BrokerCredentialGuidance>> = {
  etrade: {
    kind: "oauth1_per_login",
    envNames: { paper: [], live: [] },
    summary:
      "E*TRADE signs in with OAuth 1.0a per user: authorize once, then enter the PIN E*TRADE issues. Tokens expire daily (Eastern) and renew from the hub.",
  },
  alpaca: {
    kind: "api_key_pair",
    envNames: {
      paper: ["ALPACA_PAPER_API_KEY", "ALPACA_PAPER_SECRET_KEY", "ALPACA_PAPER_URL"],
      live: ["ALPACA_LIVE_API_KEY", "ALPACA_LIVE_SECRET_KEY", "ALPACA_LIVE_URL"],
    },
    summary:
      "Alpaca signs in with an API key pair for the selected trading type. The key and secret are entered once by the user — the server verifies them against Alpaca before storing, and the secret is never shown again.",
  },
  // Issue #3990: Public signs in with ONE pasted personal access
  // token (no key pair, no OAuth grant that works in practice — the
  // metadata-document flow is refused by Public's authorization
  // server; see publicOAuth.ts). The token is verified against the
  // hosted MCP server (tools/list) before it is stored.
  public: {
    kind: "personal_token",
    envNames: { paper: [], live: [] },
    summary:
      "Public.com signs in with a personal access token: create one on the API settings page of your Public account and paste it here. The server verifies it against Public's MCP server before storing, and the token is never shown again.",
  },
};

/** The sign-in this broker requires. Total by type: every broker answers. */
export function brokerCredentialGuidance(broker: BrokerId): BrokerCredentialGuidance {
  return CREDENTIAL_GUIDANCE[broker];
}

export const BROKER_CATALOG = {
  etrade: {
    id: "etrade",
    label: "E*TRADE",
    credentialKind: "oauth1_per_login",
    assetClasses: ["equity", "options"],
    tradingTypeForEnvironment: { TEST: "paper", PROD: "live" },
    supports: {
      quote: true,
      detailedQuote: true,
      accounts: true,
      positions: true,
      positionLots: true,
      portfolioRisk: true,
      optionChains: true,
      optionExpireDates: true,
      orderPreview: true,
      orderPlace: true,
      marketScreening: true,
      optionsScanner: true,
      ivHistory: true,
      // E*TRADE serves all four through its own routes (/etrade/orders/remote,
      // /etrade/transactions, /etrade/alerts, /etrade/watchlists).
      orderHistory: true,
      accountActivity: true,
      alerts: true,
      watchlists: true,
      // Issue #3390: both brokers cancel through the neutral order seam.
      orderCancel: true,
      // Issue #3374: the discovery engine runs on this broker's chains.
      optionsDiscovery: true,
    },
    statusVocabulary: {
      protocol: "etrade_oauth_rest",
      mode: { paper: "sandbox_api", live: "live_oauth" },
      environment: { paper: "paper", live: "live" },
    },
    copilot: {
      supported: true,
      autonomousCycle: true,
      // The E*TRADE client has no native bracket/conditional placement;
      // the preview carries the legs, placement is separate exit orders.
      bracketOrders: "preview",
      percentBrackets: true,
      barsProvider: "yfinance",
      tools: {
        quote: "etrade_get_quote",
        preview: "etrade_preview_order",
        place: "etrade_execute_order",
        orders: null,
        cancel: null,
      },
    },
  },
  alpaca: {
    id: "alpaca",
    label: "Alpaca",
    credentialKind: "api_key_pair",
    assetClasses: ["equity", "options"],
    tradingTypeForEnvironment: { TEST: "paper", PROD: "live" },
    supports: {
      quote: true,
      detailedQuote: true,
      accounts: true,
      positions: true,
      // Issue #3328: Alpaca exposes no tax-lot endpoint, and it does not need
      // one — FIFO over its account fills derives the lots, and quantity whose
      // fills predate the retained window is reported as a coverage gap.
      positionLots: true,
      // Issue #3324: the risk model is the platform's, fed by this broker's
      // own book, chains, and spot price.
      portfolioRisk: true,
      optionChains: true,
      optionExpireDates: true,
      orderPreview: true,
      orderPlace: true,
      // Issue #3325: Alpaca has no screener API, and it does not need one — the
      // screening math is the platform's (#3272) and only the quotes are the
      // broker's. The adapter implements `screenMarkets` on its own quotes, so
      // the capability is real rather than provider-side wishful thinking.
      marketScreening: true,
      optionsScanner: true,
      ivHistory: true,
      // Issue #3359: Alpaca serves order history (`GET /v2/orders`) and account
      // activities (`GET /v2/account/activities`). It has no alerts model, and
      // its watchlists are not the platform's E*TRADE-shaped watchlist store --
      // both are declared false so the panel states the gap by name.
      orderHistory: true,
      accountActivity: true,
      alerts: false,
      // Issue #3434: Alpaca serves GET /v2/watchlists, so the declared absence is
      // no longer true. The panel now renders the tenant's own lists; create and
      // delete stay on E*TRADE's routes until a write seam exists.
      watchlists: true,
      // Issue #3390: both brokers cancel through the neutral order seam.
      orderCancel: true,
      // Issue #3388: the engine composes on the selected broker's chains
      // (`platformChainSource`), so Alpaca produces its own runs.
      optionsDiscovery: true,
    },
    statusVocabulary: {
      protocol: "alpaca_rest_v2",
      mode: { paper: "paper_api", live: "live_api" },
      environment: { paper: "paper", live: "live" },
    },
    copilot: {
      supported: true,
      autonomousCycle: true,
      bracketOrders: "native",
      percentBrackets: true,
      barsProvider: "alpaca",
      tools: {
        quote: "alpaca_get_quote",
        preview: "alpaca_preview_order",
        place: "alpaca_place_order",
        orders: "alpaca_orders",
        cancel: "alpaca_cancel_bracket_ladder",
      },
    },
  },
  // Issue #3990: Public.com as a live broker. The trading surface
  // is Public's hosted MCP server (mcp_json_rpc); quotes and chains
  // ride the data adapter over the same transport.
  public: {
    id: "public",
    label: "Public.com",
    credentialKind: "personal_token",
    assetClasses: ["equity", "options"],
    // Public has NO paper trading mode. TEST resolves to the paper
    // bucket for the platform's mode machinery (the type stays
    // total, and every mode call site keeps working), and placement
    // in TEST is refused with FAILURE_PUBLIC_NO_PAPER_MODE at the
    // platform seam — the refusal, not the mapping, is the honest
    // statement. PROD is live, an explicit act.
    tradingTypeForEnvironment: { TEST: "paper", PROD: "live" },
    supports: {
      quote: true,
      detailedQuote: true,
      accounts: true,
      positions: true,
      // No tax-lot endpoint verified on the MCP surface.
      positionLots: false,
      // Issue #3324's reasoning holds here too: the risk model is
      // the platform's, fed by this broker's own book, chains, and
      // spot price.
      portfolioRisk: true,
      optionChains: true,
      optionExpireDates: true,
      orderPreview: true,
      orderPlace: true,
      // Issue #3990 Slice D: the platform implements screenMarkets
      // (NeutralMarketScreener over its own quotes), so screening is
      // declared — a Public tenant can screen on Public.com.
      marketScreening: true,
      // The scanner / IV-history / discovery engines compose on the
      // broker's own chains (OptionChainSource / platformChainSource),
      // and Public serves chains — so they are true here, fed by
      // Public's chains, never another broker's.
      optionsScanner: true,
      ivHistory: true,
      // Issue #3359: Public serves order history (get_orders). No
      // get_history tool is verified, so account activity is a
      // stated gap; there is no watchlists or alerts tool either.
      orderHistory: true,
      accountActivity: false,
      alerts: false,
      watchlists: false,
      orderCancel: true,
      optionsDiscovery: true,
    },
    statusVocabulary: {
      protocol: "mcp_json_rpc",
      mode: { paper: "mcp_remote", live: "mcp_remote" },
      environment: { paper: "paper", live: "live" },
    },
    copilot: {
      supported: true,
      // The autonomous cycle may run on Public: in TEST it previews
      // and refuses placement with the named outcome; in PROD it
      // places, which is the user's explicit live act.
      autonomousCycle: true,
      bracketOrders: "native",
      percentBrackets: true,
      // Bars do not come from Public (no bars tool on the MCP
      // surface) — they come from the tenant's data provider
      // (alpaca by default), so the bars provider is hybrid.
      barsProvider: "hybrid",
      tools: {
        quote: "public_get_quote",
        preview: "public_preview_order",
        place: "public_place_order",
        orders: "public_orders",
        cancel: "public_cancel_order",
      },
    },
  },
} as const satisfies Record<BrokerId, BrokerDefinition>;

/**
 * The ids the routed order surface accepts. Derived from the catalog so the
 * route cannot drift from the broker list again (the previous hand-written
 * copy admitted in its own comment that it "mirrors" the client list).
 */
export const ROUTED_BROKER_IDS = Object.keys(BROKER_CATALOG) as readonly BrokerId[];

/**
 * Legacy ids that were never brokers. `sandbox` is E*TRADE's test environment;
 * it has been accepted as a platform id since the registry was introduced.
 * Resolve it to the pair it always meant instead of rejecting historical
 * callers, and never let it reach a broker-facing surface as a broker name.
 */
const LEGACY_BROKER_ALIASES: Readonly<
  Record<string, { readonly broker: BrokerId; readonly environment: TradingEnvironment }>
> = {
  sandbox: { broker: "etrade", environment: "TEST" },
};

export interface BrokerSelection {
  readonly broker: BrokerId;
  readonly environment: TradingEnvironment;
  readonly tradingType: TradingType;
  /** True when the input used a legacy alias (e.g. `sandbox`). */
  readonly legacy: boolean;
}

export function isBrokerId(value: unknown): value is BrokerId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(BROKER_CATALOG, value.toLowerCase());
}

/** Environment → trading type for one broker. Unknown broker is a caller bug. */
export function tradingTypeFor(broker: BrokerId, environment: TradingEnvironment): TradingType {
  return BROKER_CATALOG[broker].tradingTypeForEnvironment[environment];
}

/**
 * Resolve a (broker, environment) request into the pair the platform acts on.
 *
 * Accepts the legacy `sandbox` id as (etrade, TEST). Refuses anything else it
 * does not know — an unknown broker must never silently become the default,
 * and an unknown environment must never silently become PROD.
 */
export function resolveBrokerSelection(input: {
  broker?: unknown;
  environment?: unknown;
}): BrokerSelection | null {
  const rawBroker = typeof input.broker === "string" ? input.broker.trim().toLowerCase() : "";
  if (!rawBroker) return null;

  const legacy = LEGACY_BROKER_ALIASES[rawBroker];
  const broker: BrokerId | null = legacy ? legacy.broker : isBrokerId(rawBroker) ? (rawBroker as BrokerId) : null;
  if (!broker) return null;

  const rawEnv = typeof input.environment === "string" ? input.environment.trim().toUpperCase() : "";
  const environment: TradingEnvironment | null =
    rawEnv === "TEST" || rawEnv === "PROD"
      ? (rawEnv as TradingEnvironment)
      : rawEnv === ""
        ? (legacy?.environment ?? null)
        : null;
  if (!environment) return null;

  return {
    broker,
    environment,
    tradingType: tradingTypeFor(broker, environment),
    legacy: Boolean(legacy),
  };
}

/** True when the selected broker can perform the operation (#3233). */
export function brokerSupports(broker: BrokerId, operation: BrokerOperation): boolean {
  return BROKER_CATALOG[broker].supports[operation];
}

/** Issue #3839: the copilot capability for one broker. Total by type. */
export function brokerCopilotCapability(broker: BrokerId): BrokerCopilotCapability {
  return BROKER_CATALOG[broker].copilot;
}

/** The brokers the copilot supports, derived from the catalog — never a list. */
export function copilotBrokerIds(): BrokerId[] {
  return (Object.keys(BROKER_CATALOG) as BrokerId[]).filter(
    (broker) => BROKER_CATALOG[broker].copilot.supported,
  );
}

/** Narrowing guard used by the copilot's selection resolver. */
export function isCopilotBroker(broker: string): broker is BrokerId {
  return isBrokerId(broker) && BROKER_CATALOG[broker].copilot.supported;
}

/**
 * Guard used by the registry: every registered platform id must be a broker in
 * the catalog, or a declared legacy alias. A new platform registered without a
 * catalog entry fails here instead of surfacing as an unlabeled broker.
 */
export function assertBrokerCatalogComplete(registeredIds: readonly string[]): void {
  const missing = registeredIds.filter(
    (id) => !isBrokerId(id) && !Object.prototype.hasOwnProperty.call(LEGACY_BROKER_ALIASES, id.toLowerCase()),
  );
  if (missing.length > 0) {
    throw new Error(
      `Broker catalog incomplete (#3232): registered platform id(s) without a catalog entry: ${missing.join(", ")}. ` +
        `Add the broker to src/trading/brokerCatalog.ts instead of registering it bare.`,
    );
  }
}
