/**
 * Natural-language entry points for the options strategy screener (capability 2)
 * and the best-trade picker (capability 3). Capability 1 (single-contract
 * screening) stays on the existing `options_screen` NLQ action.
 */

import { UnifiedOptionsService, type OpportunityScanResult } from "../trading";
import { defaultRegistry } from "../trading";
import { MAX_SCAN_SYMBOLS, type OpportunityRow, type ScanMatrixRow, type ScanMode, type ScanRequestTemplate, type ScanTypeRollup } from "../trading";
import type { ScanRunStore } from "../trading";
import { applyProfileFields, profileDisclosure, toProfileRef, type ProfileRef, type StrategyProfile } from "../trading";
import type { StrategyProfileStore } from "../trading";
import { DynamicOptionsScreener } from "../trading";
import type {
  ExpectedIvDirection,
  OptionStrategyType,
  OptionThesis,
  StrategyRequest,
} from "../trading";
import type { RiskProfile } from "../trading";
import { buildTypeRollup, type StrategyTypeRollup } from "../trading";
import { getEventCalendarCoverage, getSymbolEventCalendar } from "../services/eventCalendar";
import {
  formatDiscoveryRunSummary,
  type DiscoveryRunOutcome,
  type DiscoveryRunRequest,
} from "../services/discoveryService";
import type { DiscoveryModeRequest } from "../services/researchDiscovery";
import type { FitDiscoveryRunner } from "../services/fitDiscoveryRunner";
import type { ComparisonNlqRunner } from "../services/comparisonNlqRunner";
import type { ProductionComparisonResult } from "../services/comparisonRunner";
import type { Outlook } from "../services/researchGates";
import type { GoalKind } from "../services/goalScenarioStore";
import { validateStrategyRequest, type StrategyScreenFilter } from "../trading";
import { parseScanRequestTemplate } from "../trading";
import {
  createScannerScreenPorts,
  createStrategyScreenAgents,
  createStrategyScreenPorts,
  panelResultToPipelineResult,
} from "../workflows/strategyScreenPorts";
import {
  memoryStageClaims,
  memoryStageStorage,
  runOptionsScreenWorkflow,
} from "../workflows/optionsScreenWorkflow";
import {
  optionsArtifactKey,
  type OptionsStageStorage,
} from "../workflows/optionsScreenPorts";
import type { StageQueueSend } from "../workflows/stageQueueTransport";
import type { PanelDiscoveryResult } from "../services/recommendationKernel";

export { buildTypeRollup } from "../trading";
export type { StrategyTypeRollup } from "../trading";

export type OptionsStrategyAction = "options_strategies" | "options_best_trade" | "options_opportunities" | "options_fit_discovery" | "options_comparison";

/**
 * Issue #1162 (epic #1096 Phase 6; deferred from Phase 2): a parsed
 * bidirectional fit question for the Phase 2 Name↔Strategy discovery
 * service. `structure` is a catalog/pipeline structure id as detected
 * (researchDiscovery resolves catalog ids to pipeline structures).
 */
export interface FitDiscoverySpec {
  direction: "name_to_strategies" | "strategy_to_names";
  symbol?: string;
  structure?: string;
  goalKind?: GoalKind;
  outlook: Outlook;
  symbols?: string[];
}

export type OpportunityScope =
  | { kind: "watchlist"; name?: string }
  | { kind: "symbols"; symbols: string[] }
  | { kind: "universe"; filters: Record<string, unknown>; maxSymbols: number };

export interface OptionsStrategyIntent {
  action: OptionsStrategyAction;
  filters: {
    request: Partial<StrategyRequest>;
    riskProfile: RiskProfile;
    strategyFilter: StrategyScreenFilter;
    targetPriceInferred: boolean;
    thesisInferred: boolean;
    scope?: OpportunityScope;
    /** Which strategy question a scan answers (issue #23): set only on
     *  the scan path — "strategy_fit" for fit questions ("which names fit
     *  ...?"), otherwise "per_name_best". Single-name paths ignore it. */
    mode?: ScanMode;
    /** Saved strategy profile selected by name in the question (issue
     *  #28): "scan … against my income profile" sets profileName
     *  "income". Resolved against the caller's profile store at run
     *  time; an unresolvable name fails the action rather than running
     *  profile-less. */
    profileName?: string;
    showEvaluations?: boolean;
    /** Issue #1162: set only on the options_fit_discovery action. */
    fitDiscovery?: FitDiscoverySpec;
  };
}

const WATCHLIST_STOP = new Set(["MY", "THE", "A", "AN", "THIS", "EACH", "ANY", "ALL", "SAVED", "ONE"]);

const PROFILE_NAME_STOPS = new Set(["strategy", "watchlist", "against", "with", "using", "profile"]);

/**
 * Saved-profile selection (issue #28): "my <name> profile" — "against
 * my income profile", "with my income profile", "using my income
 * profile", "scan … my income profile". The capture cannot cross the
 * scope/phrasing words (watchlist / against / with / using / profile),
 * so in "across my Semis watchlist against my income profile" the first
 * "my" (the watchlist's) cannot swallow the profile name: its
 * continuation is blocked at "watchlist" and " profile" does not
 * follow there, so the match retries at the second "my" and captures
 * "income". A bare "my strategy profile" names no profile (the guard
 * below), and an empty capture is ignored.
 */
function detectProfileName(question: string): string | undefined {
  const match = question.match(
    /\bmy\s+((?:[a-z][a-z0-9_-]*)(?:\s+(?!(?:watchlist|against|with|using|profile)\b)[a-z][a-z0-9_-]*)*)\s+profile\b/i,
  );
  if (!match) return undefined;
  const name = match[1].trim().replace(/\s+/g, " ");
  if (!name || PROFILE_NAME_STOPS.has(name.toLowerCase())) return undefined;
  return name;
}

function detectScope(question: string): OpportunityScope | null {
  // Contract-level screens (e.g. "Screen call options...") are handled by options_screen, not strategy opportunity scanner
  if (/\b(?:call|put)\s+options?\b/i.test(question) && !/\bstrateg\w*\b/i.test(question)) {
    return null;
  }

  if (/\bwatch\s?lists?\b/i.test(question)) {
    const quoted = question.match(/["'`]([^"'`]{1,40})["'`]/);
    const named = question.match(/\bwatch\s?lists?\s+(?:named\s+|called\s+)?([A-Za-z][\w-]*)/i);
    const prefixed = question.match(/\b([A-Za-z][\w-]*)\s+watch\s?lists?\b/i);
    const candidate = quoted?.[1] ?? [prefixed?.[1], named?.[1]].find((n) => n && !WATCHLIST_STOP.has(n.toUpperCase()) && !/^(for|in|on|from|across|scan|best|top|options?|trade|trades|with|max|bullish|bearish|conservative|aggressive)$/i.test(n));
    return { kind: "watchlist", name: candidate?.trim() };
  }
  const list = question.match(/\b[A-Z]{2,5}(?:\s*(?:,|and|&)\s*[A-Z]{2,5})+\b/);
  if (list) {
    const symbols = list[0].split(/\s*(?:,|and|&)\s*/).filter((s) => !NOT_TICKERS.has(s));
    if (symbols.length >= 2) return { kind: "symbols", symbols };
  }

  // If a single explicit symbol is provided (and not a multi-symbol list), single-symbol actions take precedence over broad scope
  if (detectSymbol(question)) {
    return null;
  }
  if (/\b(?:across|entire|whole|full)\b[^.]*\b(?:stocks?|market|universe|spectrum|listings)\b|\b(?:large|mega)[- ]?cap\b|\bmarket[- ]wide\b|\bacross\s+(?:the\s+)?(?:nasdaq|nyse|amex)\b/i.test(question)) {
    const filters: Record<string, unknown> = {};
    const cap = question.match(/market\s*cap(?:italization)?\s*(?:>|over|above|at least)\s*\$?([\d,.]+)\s*(t|b|m)?/i);
    if (cap) {
      const amount = parseNumber(cap[1]);
      const unit = (cap[2] || "b").toLowerCase();
      filters.minMarketCap = unit === "t" ? amount * 1000 : unit === "m" ? amount / 1000 : amount;
    } else if (/\bmega[- ]?cap\b/i.test(question)) filters.minMarketCap = 200;
    else filters.minMarketCap = 50;
    const price = question.match(/\b(?:price|priced|trading)\s+(?:between|from)\s*\$?([\d,.]+)\s*(?:and|to|-)\s*\$?([\d,.]+)/i);
    if (price) { filters.minPrice = parseNumber(price[1]); filters.maxPrice = parseNumber(price[2]); }
    const ex = question.match(/\b(nasdaq|nyse|amex)\b/i);
    if (ex) filters.exchange = ex[1].toUpperCase();
    if (/\b(gainers?|momentum)\b/i.test(question)) filters.gainersOnly = true;
    const top = question.match(/\b(?:top|first|up to|max(?:imum)?)\s*(\d+)\b/i);
    return { kind: "universe", filters, maxSymbols: Math.min(top ? Number(top[1]) : 10, MAX_SCAN_SYMBOLS) };
  }
  const underlyingsMatch = question.match(/(?:scan|screen|across|up to|max(?:imum)?)\s*(\d+)\s*underlyings\b/i);
  if (underlyingsMatch) {
    const filters: Record<string, unknown> = { minMarketCap: 50 };
    return { kind: "universe", filters, maxSymbols: Math.min(Number(underlyingsMatch[1]), MAX_SCAN_SYMBOLS) };
  }
  return null;
}

const NOT_TICKERS = new Set([
  "DTE", "IV", "OI", "ITM", "OTM", "ATM", "ETF", "PUT", "CALL", "NLQ", "USD", "POP", "RSI", "THE", "AND", "FOR",
  "BEST", "TOP", "PICK", "WITH", "LOSS", "MAX", "MIN", "RR", "A", "I", "IN", "ON", "TO", "OF",
]);

const OPTIONS_CONTEXT = /\b(options?|calls?|puts?|spreads?|straddles?|strangles?|condors?|debit|credit|iv|dte|delta|strike|strateg(?:y|ies)|max\s*profit|max\s*loss|underlyings?|iron\s*condor|covered\s*call|protective\s*put|collar|butterfly)\b/i;
const BEST_TRADE = /\b(?:best|top)\s+(?:\w+\s+){0,3}(?:trades?|plays?|strateg(?:y|ies)|spreads?|setups?)\b/i;
const PICK_TRADE = /\b(?:pick|choose|recommend|suggest|find)\s+(?:me\s+)?(?:the\s+|a\s+|an\s+)?(?:\w+\s+){0,3}(?:trades?|strateg(?:y|ies)|spreads?)\b/i;
const STRATEGY_SCREEN = /\b(?:(?:find|screen|scan|search|show|get|list)?\s*(?:all\s+)?(?:options?\s+)?strateg(?:y|ies)(?:\s+(?:where|with|that|having|evaluated|ledger|screen|scan|screener))?|(?:all|every)\s+strateg(?:y|ies)|(?:debit|credit|vertical)\s+spreads?|straddles?|strangles?|iron\s+condors?|max\s*profit\s*(?:>|is\s*(?:more|greater|higher)\s*than)\s*max\s*loss)\b/i;

function parseNumber(text: string): number {
  return Number(text.replace(/,/g, ""));
}

function detectSymbol(question: string): string | undefined {
  const upper = [...question.matchAll(/\$?\b([A-Z]{1,5})\b/g)].map((m) => m[1]).find((t) => !NOT_TICKERS.has(t));
  if (upper) return upper;
  const prepositional = question.match(/\b(?:for|on|in)\s+\$?([A-Za-z]{1,5})\b/i);
  if (prepositional && !NOT_TICKERS.has(prepositional[1].toUpperCase()) && !/^(the|a|an|my|any|all)$/i.test(prepositional[1])) {
    return prepositional[1].toUpperCase();
  }
  return undefined;
}

function registryPhrases(): Array<{ phrase: string; id: string }> {
  const out: Array<{ phrase: string; id: string }> = [];
  for (const def of defaultRegistry.list()) {
    for (const name of [def.label, ...def.aliases]) {
      const phrase = name.toLowerCase().replace(/[’']/g, "").trim();
      if (phrase.split(/\s+/).length >= 2 || phrase.length >= 6) out.push({ phrase, id: def.id });
    }
  }
  return out.sort((a, b) => b.phrase.length - a.phrase.length);
}

function detectStrategies(question: string): OptionStrategyType[] {
  const found = new Set<OptionStrategyType>();
  let q = question.toLowerCase().replace(/[’']/g, "");
  if (/\b(all|every|each)\s+(?:option\s+)?strateg(?:y|ies)\b|\ball\s+strategy\s+types\b/.test(q)) return ["all"];
  for (const { phrase, id } of registryPhrases()) {
    const re = new RegExp(`(?<![a-z])${phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+")}(?![a-z])`, "g");
    if (re.test(q)) {
      found.add(id);
      q = q.replace(re, " ");
    }
  }
  if (/call\s+debit\s+spread/.test(q)) found.add("call_debit_spread");
  if (/put\s+debit\s+spread/.test(q)) found.add("put_debit_spread");
  if (/call\s+credit\s+spread/.test(q)) found.add("call_credit_spread");
  if (/put\s+credit\s+spread/.test(q)) found.add("put_credit_spread");
  if (/(?<!call |put )debit\s+spread/.test(q)) { found.add("call_debit_spread"); found.add("put_debit_spread"); }
  if (/(?<!call |put )credit\s+spread/.test(q)) { found.add("call_credit_spread"); found.add("put_credit_spread"); }
  if (/iron\s+condor/.test(q)) found.add("iron_condor");
  if (/straddle/.test(q)) found.add("long_straddle");
  if (/strangle/.test(q)) found.add("long_strangle");
  if (/long\s+call/.test(q)) found.add("long_call");
  if (/long\s+put/.test(q)) found.add("long_put");
  return [...found];
}

function detectThesis(question: string, strategies: OptionStrategyType[]): { thesis: OptionThesis; inferred: boolean } {
  if (/\b(bearish|downside|decline|drop(?:s|ping)?|fall(?:s|ing)?|sell[- ]?off|short)\b/i.test(question)) return { thesis: "bearish", inferred: false };
  if (/\b(neutral|range[- ]?bound|sideways|flat|stays?\s+(?:flat|between)|not\s+move|pinned)\b/i.test(question)) return { thesis: "range_bound", inferred: false };
  if (/\b(big\s+move|large\s+move|volatile|volatility\s+expansion|breakout|earnings\s+move)\b/i.test(question)) return { thesis: "large_move", inferred: false };
  if (/\b(bullish|upside|rally|rall(?:y|ies)|go(?:es)?\s+up|rises?|climbs?)\b/i.test(question)) return { thesis: "bullish", inferred: false };
  if (strategies.includes("iron_condor")) return { thesis: "range_bound", inferred: true };
  if (strategies.some((s) => s === "long_straddle" || s === "long_strangle")) return { thesis: "large_move", inferred: true };
  if (strategies.some((s) => s === "long_put" || s === "put_debit_spread" || s === "call_credit_spread")) return { thesis: "bearish", inferred: true };
  return { thesis: "bullish", inferred: true };
}

function detectTargetDate(question: string, maxDte?: number): string {
  const iso = question.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1];
  const rel = question.match(/\b(?:in|within|by)\s+(\d+)\s*(day|week|month)s?\b/i);
  const days = rel
    ? Number(rel[1]) * (rel[2].toLowerCase() === "week" ? 7 : rel[2].toLowerCase() === "month" ? 30 : 1)
    : maxDte ?? 30;
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

const FIT_SYMBOL_STOP = new Set([
  "MY", "THE", "A", "AN", "THIS", "THAT", "YOUR", "OUR", "ANY", "ALL", "ME", "IT",
]);

function thesisToOutlook(thesis: OptionThesis): Outlook {
  return thesis === "large_move" ? "volatile" : thesis;
}

function detectFitGoalKind(question: string): GoalKind | undefined {
  if (/\bincome\b/i.test(question)) return "income";
  if (/\b(?:hedge|protect(?:ion)?)\b/i.test(question)) return "hedge_protect";
  if (/\b(?:earnings|volatility|event)\b/i.test(question)) return "volatility_event";
  return undefined;
}

/**
 * Issue #1162 (epic #1096 Phase 6; the NLQ phrases Phase 2 deferred):
 * bidirectional fit phrasing for the Phase 2 Name↔Strategy discovery
 * service — "what strategies fit NVDA?" / "what fits AAPL into
 * earnings?" (Name→Strategies) and "find me income names for an iron
 * condor" / "which names fit a long straddle?" (Strategy→Names).
 *
 * The patterns are deliberately tight so existing routes keep their
 * questions: the #14 discovery branch ("discover setups") and the #23
 * strategy-fit scan keep working because a fit question must either
 * name a strategy AND ask for names, or use explicit "fit" phrasing
 * with a plausible ticker (stoplisted words and known non-tickers
 * never capture as a symbol).
 */
function detectFitDiscovery(question: string): FitDiscoverySpec | null {
  const wantsNames =
    /\bnames?\b/i.test(question) && /\b(?:fit|for|suited\s+to|suit)\b/i.test(question);
  if (wantsNames) {
    const strategies = detectStrategies(question).filter((s) => s !== "all");
    if (strategies.length > 0) {
      const { thesis } = detectThesis(question, strategies);
      const scope = detectScope(question);
      return {
        direction: "strategy_to_names",
        structure: strategies[0],
        outlook: thesisToOutlook(thesis),
        goalKind: detectFitGoalKind(question),
        ...(scope?.kind === "symbols" ? { symbols: scope.symbols } : {}),
      };
    }
  }

  const nameMatch =
    question.match(/\b(?:what|which)\s+(?:strategies|trades)\s+(?:fit|suits?)\s+(?:for\s+)?\$?([A-Za-z]{1,5})\b/i) ??
    question.match(/\bstrategies\s+that\s+fit\s+(?:for\s+)?\$?([A-Za-z]{1,5})\b/i) ??
    question.match(/\bwhat\s+fits\s+(?:for\s+)?\$?([A-Za-z]{1,5})\b/i);
  if (nameMatch) {
    const symbol = nameMatch[1].toUpperCase();
    if (!NOT_TICKERS.has(symbol) && !FIT_SYMBOL_STOP.has(symbol)) {
      const { thesis } = detectThesis(question, []);
      return {
        direction: "name_to_strategies",
        symbol,
        outlook: thesisToOutlook(thesis),
        goalKind: detectFitGoalKind(question),
      };
    }
  }
  return null;
}

/** Returns null when the question is not about multi-leg strategies or a best-trade pick. */
export function parseOptionsStrategyIntent(question: string): OptionsStrategyIntent | null {
  if (/\b(?:call|put)\s+options?\b/i.test(question) && !/\b(?:strateg\w*|credit\s+spread|debit\s+spread|vertical\s+spread|bull\s+spread|bear\s+spread|condor|straddle|strangle|butterfly|max\s*profit|max\s*loss)\b/i.test(question)) {
    return null;
  }

  const isBest = BEST_TRADE.test(question) && OPTIONS_CONTEXT.test(question)
    || /\bbest\s+(?:options?\s+)?(?:trade|play)\b/i.test(question)
    || (PICK_TRADE.test(question) && OPTIONS_CONTEXT.test(question));
  const isStrategies = STRATEGY_SCREEN.test(question);
  let scope = detectScope(question);

  // Issue #1162: bidirectional fit phrasing ("what strategies fit
  // NVDA?", "which names fit an iron condor?") routes to the Phase 2
  // Name↔Strategy discovery service — but ONLY when the question
  // carries no scan scope. A scoped fit question ("which names in my
  // Semis watchlist fit an iron condor?") is the #23 scanner's
  // strategy_fit mode over the caller's own names and keeps that
  // reading; discovery is the unscoped question over the provider
  // universe. Checked before the #14 discovery branch and the
  // strategy-screen gates: a fit question is view-light by definition
  // and names either a ticker or a strategy, which the tight detector
  // requires explicitly.
  const fitDiscovery = !scope ? detectFitDiscovery(question) : null;
  if (fitDiscovery) {
    return {
      action: "options_fit_discovery",
      filters: {
        request: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        fitDiscovery,
      },
    };
  }

  // Issue #14: discovery phrasing ("discover setups", "find setups",
  // "what's setting up") is view-less by definition — it routes to
  // the discovery pipeline, never to a thesis-bearing action, and it
  // bypasses the strategy-keyword gates below (a discovery question
  // names no strategy). The default scope is the caller's watchlists
  // (Decision 1); caps ride in the request at the parser's scan
  // defaults, overridable by the question's own stated caps.
  // Issue #1918: discovery phrasing routes to the unified
  // options_fit_discovery action's scope leg (no fitDiscovery spec)
  // — the removed options_discovery action's only phrase family.
  if (
    /\b(?:discover\w*|find\s+(?:me\s+)?setups?|setups?\s+(?:are\s+)?forming|what(?:'s|\s+is)\s+setting\s+up)\b/i.test(
      question,
    )
  ) {
    return {
      action: "options_fit_discovery",
      filters: {
        request: { maxPlannedLoss: 500, minRewardRisk: 1.5 },
        riskProfile: "balanced",
        strategyFilter: {},
        targetPriceInferred: false,
        thesisInferred: false,
        scope: scope ?? { kind: "watchlist" },
      },
    };
  }

  const cleanedForStrategy = question.replace(/\b(?:bid[-/ ]?ask\s+spread|spread\s*(?:under|below|<|<=|at most|\d+\s*%))\b/gi, "");
  const hasStrategyKeywords = /\b(opportunit\w*|(?:option\s+)?trades?|trade\s+ideas?|spreads?|strateg\w*|best\s+trades?|condors?|straddles?|strangles?|butterfl\w*|max\s*profit|max\s*loss)\b/i.test(cleanedForStrategy);

  if (!isBest && !isStrategies && (!scope || !hasStrategyKeywords)) {
    if (!hasStrategyKeywords) return null;
  }

  if (!scope && !detectSymbol(question) && hasStrategyKeywords) {
    const underlyingsMatch = question.match(/(?:scan|screen|across|up to|max(?:imum)?)\s*(\d+)\s*underlyings\b/i);
    const count = underlyingsMatch ? Math.min(Number(underlyingsMatch[1]), MAX_SCAN_SYMBOLS) : 25;
    scope = { kind: "universe", filters: { minMarketCap: 50 }, maxSymbols: count };
  }

  const isScan = scope !== null
    && hasStrategyKeywords
    && !/\b(buy|sell)\s+\d+\b/i.test(question);
  if (!isBest && !isStrategies && !isScan) return null;
  if (/\b(buy|sell)\s+\d+\s+(?:shares?\s+of\s+)?[A-Za-z]{1,5}\b/i.test(question) && !OPTIONS_CONTEXT.test(question)) return null;

  const detected = detectStrategies(question);
  const { thesis, inferred: thesisInferred } = detectThesis(question, detected);

  const request: Partial<StrategyRequest> = {
    symbol: detectSymbol(question),
    thesis,
    expectedIvDirection: /\biv\s+(?:crush|fall|drop|decline|contract)|volatility\s+(?:falls?|drops?|crush)/i.test(question)
      ? "fall"
      : /\biv\s+(?:rise|rising|expan\w*|increase)|volatility\s+(?:rises?|expands?)/i.test(question)
        ? "rise"
        : "unchanged" as ExpectedIvDirection,
    allowedStrategies: detected.length > 0 ? detected : ["all"],
    maxPlannedLoss: 500,
    minRewardRisk: 1.5,
    minDte: 14,
    maxDte: 60,
    maxQuoteAgeSeconds: 60,
    contractLimit: 500,
    candidateLimit: 10,
    maxStrikesPerSide: 12,
    maxIronCondors: 100,
    eventPolicy: "warn",
  };

  const targetMatch = question.match(/(?:target(?:\s+price)?(?:\s+of)?|reach(?:es|ing)?|hits?|(?:rall(?:y|ies)|drops?|falls?|moves?|goes?|climbs?)\s+to|\bto)\s*\$\s*(\d[\d,]*(?:\.\d+)?)/i)
    || question.match(/\btarget(?:\s+price)?(?:\s+of)?\s*(\d[\d,]*(?:\.\d+)?)/i);
  if (targetMatch) request.targetPrice = parseNumber(targetMatch[1]);

  const dteRange = question.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:dte|days? to expiration)/i);
  if (dteRange) {
    request.minDte = Number(dteRange[1]);
    request.maxDte = Number(dteRange[2]);
  } else {
    const minDte = question.match(/(?:dte\s*(?:>|over|above)|at least\s*)(\d+)\s*(?:dte|days? to expiration)/i);
    const maxDte = question.match(/(?:dte\s*(?:<|under|below)|(?:under|below|within|at most)\s*)(\d+)\s*(?:dte|days? to expiration)/i);
    if (minDte) request.minDte = Number(minDte[1]);
    if (maxDte) request.maxDte = Number(maxDte[1]);
  }
  request.targetDate = detectTargetDate(question, request.maxDte);

  const loss = question.match(/(?:max(?:imum)?\s+(?:planned\s+)?loss|risk(?:ing)?|budget|capital)\s*(?:of|under|below|<|at most|up to|:)?\s*\$?\s*(\d[\d,]*)/i);
  if (loss) request.maxPlannedLoss = parseNumber(loss[1]);
  // Parse explicit reward/risk or profit-to-loss multiplier/percentage (e.g. 1:2, 1:3, 1:4, 2:1, 3:1, by 50%, by 2x)
  let parsedRewardRisk: number | undefined;

  // 1. Ratio patterns like 1:2, 1:3, 1:4, 2:1, 3:1, 1 to 2, 2 to 1
  const ratioMatch = question.match(/(?:(?:reward\s*(?:\/|to)\s*risk|r\/r|profit\s*(?:\/|to)\s*loss|by|at least|>=|>)\s*)?(\d+(?:\.\d+)?)\s*(?::|to|\/)\s*(\d+(?:\.\d+)?)/i);
  if (ratioMatch) {
    const n1 = Number(ratioMatch[1]);
    const n2 = Number(ratioMatch[2]);
    if (n1 > 0 && n2 > 0) {
      parsedRewardRisk = Number((Math.max(n1, n2) / Math.min(n1, n2)).toFixed(2));
    }
  }

  // 2. Multiplier patterns like 2x, 3x, 4x, 1.5x
  const multMatch = question.match(/(?:by|at least|>=|>)\s*(\d+(?:\.\d+)?)\s*x\b/i) ||
                    question.match(/(\d+(?:\.\d+)?)\s*x\s*(?:max\s*loss|loss|risk)/i);
  if (multMatch) {
    const m = Number(multMatch[1]);
    if (m > 0) parsedRewardRisk = m;
  }

  // 3. Percentage patterns like by 50%, by 100%, 200%
  const pctMatch = question.match(/(?:by|at least|>=|>)\s*(\d+(?:\.\d+)?)\s*%/i);
  if (pctMatch && /\b(profit|loss|more|greater|higher|gain)\b/i.test(question)) {
    const pct = Number(pctMatch[1]);
    if (pct > 0) {
      parsedRewardRisk = Number((1 + pct / 100).toFixed(2));
    }
  }

  // 4. Standard reward/risk phrase: reward to risk at least 1.5
  const rr = question.match(/(?:reward\s*(?:\/|to)\s*risk|r\/r)\s*(?:>=|>|of|over|above|at least)?\s*(\d+(?:\.\d+)?)/i);
  if (rr && !parsedRewardRisk) {
    parsedRewardRisk = Number(rr[1]);
  }

  const strategyFilter: StrategyScreenFilter = {};
  if (parsedRewardRisk !== undefined) {
    request.minRewardRisk = parsedRewardRisk;
    strategyFilter.minRewardRisk = parsedRewardRisk;
    strategyFilter.maxProfitGreaterThanMaxLoss = true;
  }

  const volume = question.match(/volume\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
  if (volume) request.minVolume = parseNumber(volume[1]);
  const oi = question.match(/(?:open\s*interest|oi)\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
  if (oi) request.minOpenInterest = parseNumber(oi[1]);
  const spread = question.match(/spread\s*(?:<|under|below|at most)\s*(\d+(?:\.\d+)?)\s*%/i);
  if (spread) request.maxSpreadPct = Number(spread[1]);
  const age = question.match(/quote\s*age\s*(?:<|under|below|at most)\s*(\d+)\s*(?:s|seconds?)/i);
  if (age) request.maxQuoteAgeSeconds = Number(age[1]);

  const pop = question.match(/(?:pop|probability\s+of\s+profit|chance\s+of\s+profit)\s*(?:>|over|above|at least|of)?\s*(\d+(?:\.\d+)?)\s*%/i);
  if (pop) strategyFilter.minProbabilityOfProfit = Number(pop[1]) / 100;
  const debit = question.match(/(?:net\s+)?debit\s*(?:<|under|below|at most)\s*\$?\s*(\d[\d,]*)/i);
  if (debit) strategyFilter.maxNetDebit = parseNumber(debit[1]);
  const credit = question.match(/(?:net\s+)?credit\s*(?:>|over|above|at least)\s*\$?\s*(\d[\d,]*)/i);
  if (credit) strategyFilter.minNetCredit = parseNumber(credit[1]);
  if (/\bfresh\s+quotes?\s+only\b|\bonly\s+fresh\b/i.test(question)) strategyFilter.requireFresh = true;

  // Max profit > max loss criteria (sets to 1.0 if not already parsed to an explicit ratio)
  if (
    /\bmax\s*profit\s*(?:is\s*)?(?:more|greater|higher|>)\s*(?:than)?\s*max\s*loss\b/i.test(question) ||
    /\bprofit\s*(?:is\s*)?(?:more|greater|higher|>)\s*(?:than)?\s*loss\b/i.test(question) ||
    /\breward\s*(?:is\s*)?(?:more|greater|higher|>)\s*(?:than)?\s*risk\b/i.test(question)
  ) {
    if (parsedRewardRisk === undefined) {
      request.minRewardRisk = 1.0;
      strategyFilter.minRewardRisk = 1.0;
    }
    strategyFilter.maxProfitGreaterThanMaxLoss = true;
  }

  const riskProfile: RiskProfile = /\b(conservative|safe|safer|low[- ]risk)\b/i.test(question)
    ? "conservative"
    : /\b(aggressive|high[- ]risk|speculative)\b/i.test(question)
      ? "aggressive"
      : "balanced";

  // Issue #23: a scan answers the fit question (Q1 — "which names fit my
  // strategy?") when the question is phrased as one; every other scan
  // keeps the per-name-best reading (Q2). Only set on the scan path.
  const mode: ScanMode | undefined = scope
    ? /\bfit(s|ting)?\b/i.test(question)
      ? "strategy_fit"
      : "per_name_best"
    : undefined;

  // Issue #28: a saved profile selected by name ("against my income
  // profile") rides on the filters of BOTH the scan and single-name
  // paths; it is resolved against the caller's store at run time.
  const profileName = detectProfileName(question);

  return {
    // #1257 comparison surfacing: a single-symbol question that names
    // comparison arms (llm / quant / hybrid) and strategy keywords
    // claims the three-way comparison action. Scoped questions stay
    // scans (comparison needs one snapshot), arm-less compare
    // questions stay strategies questions, and a symbol-less claim
    // still claims it — the runner then fails clearly ("comparison
    // needs a symbol") rather than silently answering a different
    // question.
    action: scope
      ? "options_opportunities"
      : !scope && /\bcompare\b/i.test(question) && /\b(llm|quant|hybrid)\b/i.test(question) && hasStrategyKeywords
        ? "options_comparison"
        : isBest
          ? "options_best_trade"
          : "options_strategies",
    filters: {
      request, riskProfile, strategyFilter, targetPriceInferred: false, thesisInferred, scope: scope ?? undefined,
      mode,
      ...(profileName ? { profileName } : {}),
      showEvaluations: /\b(evaluated|ledger|accept(?:ed|ance)|reject(?:ed|ion)|why)\b/i.test(question) && /strateg/i.test(question),
    },
  };
}

export const OPTIONS_STRATEGY_EXAMPLES = [
  "Screen call options for NVDA with delta above 0.35, 20 to 45 DTE, volume over 50, open interest above 500, spread under 10%",
  "Rank bullish NVDA call debit spreads and put credit spreads target $260 in 30 days max loss $500 reward/risk at least 1.5",
  "What is the best trade for NVDA bullish target $260 by 2026-11-20 max loss $500 conservative",
  "Find the best bullish option trades across my Semis watchlist max loss $500",
  "Find best bullish option opportunities across large cap stocks top 10 max loss $500 conservative",
  "What strategies fit NVDA?",
  "Find me income names for an iron condor",
];

const money = (n: number | null | undefined) => (n === null || n === undefined ? "Unlimited" : `$${n.toFixed(2)}`);

interface LedgerEvaluation {
  id: string;
  label: string;
  category: string;
  status: "accepted" | "rejected" | "skipped";
  generated: number;
  accepted: number;
  summary: string;
  reasons: Array<{ reason: string; count: number }>;
}

/** One row per strategy category; candidateStrategies lists every strategy evaluated with its verdict and why. */
export function buildStrategyLedgerRows(
  evaluations: LedgerEvaluation[],
  bestScoreByStrategy: Map<string, number>,
  descriptions: Map<string, string>,
): Array<Record<string, unknown>> {
  const groups = new Map<string, LedgerEvaluation[]>();
  for (const e of evaluations) groups.set(e.category, [...(groups.get(e.category) ?? []), e]);
  return [...groups.entries()].map(([category, items]) => {
    const passed = items.filter((e) => e.status === "accepted");
    const failed = items.filter((e) => e.status !== "accepted");
    const scores = items.map((e) => bestScoreByStrategy.get(e.id)).filter((s): s is number => s !== undefined);
    const topReasons = new Map<string, number>();
    for (const e of failed) for (const r of e.reasons) topReasons.set(r.reason, (topReasons.get(r.reason) ?? 0) + r.count);
    const reason = passed.length === items.length
      ? `All ${items.length} ${category} strategies produced passing candidates.`
      : [...topReasons.entries()].sort((a, b) => b[1] - a[1]).slice(0, 2).map(([text, count]) => `${text} (${count})`).join("; ")
        || failed[0]?.summary
        || "No candidates built.";
    return {
      category,
      score: scores.length ? Math.max(...scores) : 0,
      passed: passed.length,
      failed: failed.length,
      reason,
      candidateStrategies: items.map((e) => ({
        id: e.id,
        name: e.label,
        status: e.status,
        why: e.status === "accepted" ? `${e.accepted} of ${e.generated} built candidates passed. ${e.summary}` : e.summary,
        description: descriptions.get(e.id) ?? "",
        score: bestScoreByStrategy.get(e.id),
      })),
    };
  });
}

/** Compact "Best by type:" summary clause (issue #26): the top 3 types
 *  that produced a ranked candidate, by composite. Empty when no type
 *  has a best — the clause is omitted rather than asserted falsely. */
function bestByTypeClause(rollup: StrategyTypeRollup[]): string {
  const top = rollup.filter((t) => t.best !== null).slice(0, 3);
  if (!top.length) return "";
  return ` Best by type: ${top.map((t) => `${t.label} ${t.bestComposite!.toFixed(1)}`).join("; ")}.`;
}

/** Dependencies threaded into the options actions by the NLQ runtime
 *  (issue #27's scan-run store; issue #28's profile store + userLogin). */
export interface OptionsStrategyDeps {
  scanRunStore?: ScanRunStore;
  profileStore?: StrategyProfileStore;
  userLogin?: string;
  /**
   * Issue #3186: the one pipeline's stage storage + queue for the
   * panel leg. The NLQ execution host threads its blob handle +
   * SCREENER_EVENTS binding; absent (the mesh door), the leg runs on
   * in-memory stage storage with no queue - the same no-persistence
   * behavior as the direct run it replaces, not a regression.
   * Durable stage claims need sql, which the NLQ runtime does not
   * thread; claims here are in-memory (follow-up, not a blocker -
   * today's direct run has no checkpoint at all).
   */
  pipelineStorage?: OptionsStageStorage;
  pipelineQueue?: StageQueueSend | null;
  /**
   * Issue #3327: the broker whose chains this run reads. Stamped on the saved
   * run so history is that broker's evidence; absent, the run records E*TRADE
   * (the only broker wired before provenance existed), never a guess.
   */
  broker?: "etrade" | "alpaca" | "public"; // Issue #3990
  /** Issue #14: the Phase 1 discovery runner (createDiscoveryService's
   *  return shape). When absent, the unified options_fit_discovery
   *  action's scope leg fails with an availability error — the same
   *  discipline as the profile store — rather than silently answering
   *  a different question. */
  discoveryRunner?: { run(request: DiscoveryRunRequest): Promise<DiscoveryRunOutcome> };
  /** Issue #1162: the Phase 2 Name↔Strategy fit-discovery runner
   *  (createFitDiscoveryRunner's return shape). When absent, an
   *  options_fit_discovery action fails with an availability error —
   *  the same discipline — rather than silently answering a
   *  different question. */
  fitDiscoveryRunner?: FitDiscoveryRunner;
  /** #1257 comparison surfacing: the three-way comparison runner
   *  (createComparisonRunner's return shape). When absent, an
   *  options_comparison action fails with an availability error —
   *  the same discipline — rather than silently answering a
   *  different question. */
  comparisonRunner?: ComparisonNlqRunner;
}

/**
 * Resolve a profile selected by name (issue #28). An unresolvable
 * selection FAILS the action — running without the profile the user
 * asked for would silently answer a different question. The userLogin
 * comes from deps (threaded by the orchestrator through nlq.ts from
 * the session); issue #1185: without it resolution fails closed —
 * profiles are per-user records and there is no synthetic owner.
 */
async function resolveStrategyProfile(
  deps: OptionsStrategyDeps | undefined,
  profileName: string,
): Promise<{ profile: StrategyProfile } | { error: string }> {
  if (!deps?.profileStore) {
    return { error: "Saved profiles aren't available in this context." };
  }
  if (!deps.userLogin) {
    return { error: "Saved profiles require an authenticated user in this context." };
  }
  const profile = await deps.profileStore.getByName(deps.userLogin, profileName);
  if (!profile) {
    return { error: `No saved profile named "${profileName}".` };
  }
  return { profile };
}

/**
 * #1257 comparison surfacing: the three-way comparison NLQ action.
 * Runs the same comparison as POST /trading/options/comparison
 * through the threaded runner (never a degraded quant-only run:
 * the runner itself refuses without an environment for LLM
 * generation). The assumed-target derivation mirrors the
 * single-name strategies path so a compare question without a
 * stated target still runs; the event calendar is NOT attached —
 * the comparison route does not use one, and route/NLQ parity
 * matters more than calendar annotations here.
 */
async function runComparisonAction(
  etrade: {
    fetchQuoteRemote(symbol: string): Promise<{ lastPrice: number }>;
  },
  filters: OptionsStrategyIntent["filters"] | undefined,
  deps?: OptionsStrategyDeps,
): Promise<{ count: number; status: string; summary: string; rows: Array<Record<string, unknown>>; validationError?: string; comparison?: ProductionComparisonResult }> {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  if (!filters?.request?.symbol) {
    return fail("Comparison needs a symbol — ask about one name, e.g. \"compare llm vs quant strategies for NVDA\".");
  }
  if (!deps?.comparisonRunner) {
    return fail("Three-way comparison is unavailable in this context: no comparison runner is configured.");
  }
  const request = { ...filters.request } as Partial<StrategyRequest>;
  let assumedTarget = false;
  if (request.targetPrice === undefined) {
    try {
      const quote = await etrade.fetchQuoteRemote(request.symbol!);
      const factor = request.thesis === "bearish" ? 0.95 : request.thesis === "large_move" ? 1.1 : request.thesis === "range_bound" ? 1 : 1.05;
      request.targetPrice = Number((quote.lastPrice * factor).toFixed(2));
      assumedTarget = true;
    } catch {
      return fail(`No target price given and a quote for ${request.symbol} was unavailable. Add one, e.g. "target $260".`);
    }
  }
  const validationError = validateStrategyRequest(request);
  if (validationError) return fail(validationError);
  const outcome = await deps.comparisonRunner.run({
    request: request as StrategyRequest,
    riskProfile: filters.riskProfile,
    strategyFilter: filters.strategyFilter,
  });
  if (!outcome.ok || !outcome.result) {
    return fail(outcome.error ?? "Comparison failed.");
  }
  const { artifact, generationNotes } = outcome.result;
  const arms = ["llm", "quant", "hybrid"] as const;
  const counts = arms.map((arm) => `${arm} ranked ${artifact.arms[arm].ranked.length}`).join(", ");
  const shared = artifact.overlap.sharedStructures.length
    ? ` Shared structures: ${artifact.overlap.sharedStructures.join(", ")}.`
    : "";
  const ledgerNote = outcome.ledgerPersisted
    ? ` Ledger run ${artifact.runId}.`
    : ` Run ${artifact.runId} was not persisted to the ledger (no ledger configured in this context).`;
  const summary = `Compared LLM / quant / hybrid generators for ${request.symbol} (${counts}). No winner is declared — arms accumulate ledger track records.${shared}${assumedTarget ? ` Target price assumed at $${request.targetPrice} (${request.thesis}).` : ""} Model: ${generationNotes.model ?? "none"}; cited ${generationNotes.citedCount}, dropped ${generationNotes.droppedCount}.${ledgerNote}`;
  const rows = arms.flatMap((arm) =>
    artifact.arms[arm].ranked.slice(0, 3).map((candidate, index) => ({
      arm,
      rank: index + 1,
      structure: candidate.structure,
      strategy: candidate.label,
      status: candidate.status,
      compositeScore: candidate.score ?? null,
      provenance: candidate.provenance,
    })),
  );
  return {
    count: arms.reduce((total, arm) => total + artifact.arms[arm].ranked.length, 0),
    status: "compared",
    summary,
    rows,
    comparison: outcome.result,
  };
}

export async function runOptionsStrategyAction(
  etrade: {
    client: ConstructorParameters<typeof DynamicOptionsScreener>[0];
    fetchQuoteRemote(symbol: string): Promise<{ lastPrice: number }>;
    getWatchlists(): Promise<Array<{ name: string; symbols: string[] }>>;
    screenMarketsAsync(filter?: any): Promise<{ stocks: Array<{ symbol: string; marketCap?: number }> }>;
  },
  action: OptionsStrategyAction,
  filters: OptionsStrategyIntent["filters"] | undefined,
  deps?: OptionsStrategyDeps,
): Promise<{ count: number; status: string; summary: string; rows: Array<Record<string, unknown>>; validationError?: string; rejections?: unknown[]; quoteQuality?: unknown; bestTrade?: unknown; evaluations?: unknown[]; nameLedger?: unknown[]; skipped?: Array<{ symbol: string; reason: string }>; matrix?: ScanMatrixRow[]; mode?: ScanMode; scanRunId?: string; persisted?: boolean; typeRollup?: StrategyTypeRollup[] | ScanTypeRollup[]; profileRef?: ProfileRef | null; discoveryRunId?: string; comparison?: ProductionComparisonResult }> {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  // Issue #1918: one NLQ discovery action. The unified
  // options_fit_discovery action has two explicit legs, chosen by
  // the parsed question shape — never by silent fallback: a parsed
  // fit question (fitDiscovery spec) runs the kernel fit runner;
  // a scope-only discovery question runs the discovery runner
  // (kernel discoverPanel via runPanelPipeline). A leg without its
  // runner fails explicitly inside its own runner function.
  if (action === "options_fit_discovery") {
    return filters?.fitDiscovery
      ? runFitDiscoveryAction(filters, deps)
      : runDiscoveryAction(etrade, filters, deps);
  }
  if (action === "options_comparison") {
    return runComparisonAction(etrade, filters, deps);
  }
  if (action === "options_opportunities" || !filters?.request?.symbol) {
    if (filters && !filters.scope) {
      filters.scope = { kind: "universe", filters: { minMarketCap: 50 }, maxSymbols: 25 };
    }
    return runOpportunityScan(etrade, filters, deps);
  }

  let request = { ...filters.request } as Partial<StrategyRequest>;
  // Issue #28: a profile selected in the question forms the base layer
  // of the single-name request too — applied BEFORE the assumed-target
  // derivation below so the target factor follows the EFFECTIVE thesis.
  // The question's own thesis stays explicit when the user stated it
  // (not inferred); the profile has no target field, so a stated or
  // assumed target is never overridden.
  let strategyProfile: StrategyProfile | undefined;
  let profileAppliedFields: string[] = [];
  if (filters.profileName) {
    const resolved = await resolveStrategyProfile(deps, filters.profileName);
    if ("error" in resolved) return fail(resolved.error);
    strategyProfile = resolved.profile;
    const applied = applyProfileFields(request, strategyProfile, new Set(filters.thesisInferred ? [] : ["thesis"]));
    request = applied.merged;
    profileAppliedFields = applied.appliedFields;
  }
  let assumedTarget = false;
  if (request.targetPrice === undefined) {
    try {
      const quote = await etrade.fetchQuoteRemote(request.symbol!);
      const factor = request.thesis === "bearish" ? 0.95 : request.thesis === "large_move" ? 1.1 : request.thesis === "range_bound" ? 1 : 1.05;
      request.targetPrice = Number((quote.lastPrice * factor).toFixed(2));
      assumedTarget = true;
    } catch {
      return fail(`No target price given and a quote for ${request.symbol} was unavailable. Add one, e.g. "target $260".`);
    }
  }

  const validationError = validateStrategyRequest(request);
  if (validationError) return fail(validationError);

  // Issue #16: attach this name's event calendar (server-fetched; the
  // service never throws and an uncovered name stays unverified).
  request.eventCalendar = await getSymbolEventCalendar(request.symbol!);

  // Issue #982: the pipeline executes through the unified service
  // layer (which owns engine construction); this module keeps the
  // NLQ-specific assembly around it — profile layering, the assumed
  // target derivation, validation, and the envelope below.
  //
  // Issue #3186: the single-name panel run goes through the one
  // strategy pipeline instead (same engine, staged). The envelope
  // below reads the mapped PipelineResult unchanged - only the
  // execution path changes.
  //
  // CORRECTION (2026-11-05, #26 tests): the panel leg does NOT fail
  // closed without an identity. The fail-closed was added with the
  // swap and contradicts the pre-existing #26 pins, which call this
  // action with no deps and expect a panel result. The composer
  // never invents an identity (it skips publishing, stages still
  // run, artifacts are the record), and the panel leg writes no
  // owner-scoped canonical record - persist is a pass-through,
  // delivery is deferred to the caller - so there is nothing here
  // that needs an identity to be safe. Both production hosts (NLQ
  // execution, mesh door) always thread a login, so the unscoped
  // path is a test/context fallback, exactly as on the scanner leg.
  const panelUserLogin = deps?.userLogin;
  const panelRunId = `nlq-panel:${crypto.randomUUID()}`;
  const panelStorage = deps?.pipelineStorage ?? memoryStageStorage();
  const panelOutcome = await runOptionsScreenWorkflow(
    {
      runId: panelRunId,
      userLogin: panelUserLogin,
      request: {
        assetClass: "options",
        runIdentity: { runId: panelRunId },
        trigger: "manual",
        classInput: {
          strategyRequest: request as StrategyRequest,
          strategyFilter: filters.strategyFilter,
          riskProfile: filters.riskProfile,
          alternatives: 3,
        },
      },
    },
    {
      stages: createStrategyScreenPorts({
        agents: createStrategyScreenAgents(etrade.client),
        storage: panelStorage,
      }),
      claims: memoryStageClaims(),
      queue: deps?.pipelineQueue ?? null,
    },
  );
  if (panelOutcome.outcome !== "completed") {
    return fail(`Options strategy screen failed at ${panelOutcome.failedStage}: ${panelOutcome.reason}`);
  }
  const panelResult = await panelStorage.get<PanelDiscoveryResult>(
    optionsArtifactKey(panelRunId, "shapeReport"),
  );
  if (!panelResult) {
    return fail("Options strategy screen completed without a report artifact; refusing to answer from nothing.");
  }
  const result = panelResultToPipelineResult(panelResult);

  const assumptions = [
    assumedTarget ? `target price assumed at $${request.targetPrice} (${request.thesis})` : "",
    filters.thesisInferred ? `thesis assumed ${request.thesis}` : "",
  ].filter(Boolean).join("; ");
  const note = assumptions ? ` Assumptions: ${assumptions}.` : "";
  const freshness = result.snapshot.screen.quoteQuality?.staleContractsReturned
    ? ` ${result.snapshot.screen.quoteQuality.staleContractsReturned} contracts have stale quotes.`
    : "";
  const scan = `Evaluated ${result.snapshot.screen.contractsEvaluated} contracts, ${result.snapshot.screen.contractsMatched} eligible; ${result.strategies.candidates.length} strategies built, ${result.ranked.length} ranked.`;

  const rankedRows = result.ranked.map((r) => ({
    rank: r.rank,
    strategy: r.candidate.label,
    legs: r.candidate.legs.map((l) => `${l.side} ${l.quantity} ${l.symbol} ${l.strike}${l.optionType[0]}`).join(" / "),
    expiry: r.candidate.expirationDate,
    netDebitCredit: r.candidate.netDebit >= 0 ? `${money(r.candidate.netDebit)} debit` : `${money(-r.candidate.netDebit)} credit`,
    maxLoss: money(r.candidate.maxLoss),
    maxProfit: r.candidate.maxProfitUnbounded ? "Unlimited" : money(r.candidate.maxProfit),
    breakevens: r.candidate.breakevens.map((b) => `$${b}`).join(", ") || "N/A",
    probabilityOfProfit: `${(r.candidate.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%`,
    targetRewardRisk: `${r.candidate.targetRewardRisk.toFixed(2)}x`,
    liquidity: r.candidate.liquidityScore.toFixed(0),
    compositeScore: r.compositeScore,
    quoteFreshness: r.candidate.dataFreshness,
  }));

  const bestScoreByStrategy = new Map<string, number>();
  for (const r of result.ranked) {
    bestScoreByStrategy.set(r.candidate.type, Math.max(bestScoreByStrategy.get(r.candidate.type) ?? 0, r.compositeScore));
  }
  const strategyDescriptions = new Map(defaultRegistry.list().map((def) => [def.id, def.description]));
  const evaluationRows = buildStrategyLedgerRows(result.strategies.evaluations, bestScoreByStrategy, strategyDescriptions);
  // Issue #26: the per-type roll-up rides on BOTH single-name actions —
  // the best-per-type winners next to the overall best (best trade) and
  // next to the ranked candidate list (strategies) — with a compact
  // clause in each summary.
  const typeRollup = buildTypeRollup(result.strategies.evaluations, result.ranked);
  const byType = bestByTypeClause(typeRollup);
  // Issue #28: the summary names the applied profile and what it
  // contributed, in the same disclosure wording the scanner uses.
  const profileClause = strategyProfile ? ` ${profileDisclosure(strategyProfile, profileAppliedFields, false)}` : "";

  if (action === "options_strategies") {
    return {
      count: rankedRows.length,
      status: result.ranked.length > 0 ? "ranked_candidates" : "no_candidates",
      summary: `Options Strategy Screener (${request.symbol}, ${request.thesis}, ${filters.riskProfile} ranking): ${scan}${freshness}${note}${byType}${profileClause}`,
      rows: filters.showEvaluations ? evaluationRows : rankedRows,
      rejections: result.snapshot.rejections.slice(0, 15),
      quoteQuality: result.snapshot.screen.quoteQuality,
      validationError: result.snapshot.validationError,
      evaluations: result.strategies.evaluations,
      nameLedger: result.strategies.nameLedger,
      typeRollup,
      ...(strategyProfile ? { profileRef: toProfileRef(strategyProfile) } : {}),
    };
  }

  const pick = result.bestTrade;
  const headline = pick.best
    ? `Best trade (${pick.status.replace("_", " ")}, ${pick.confidence} confidence, ${pick.riskProfile} profile): ${pick.best.candidate.label}. ${pick.rationale.join(" ")}`
    : `No trade: ${pick.rationale.join(" ")}`;
  const planRows = (pick.tradePlan ?? []).map((leg) => ({
    section: "TRADE PLAN",
    action: leg.action,
    quantity: leg.quantity,
    contract: leg.contract,
    type: leg.optionType,
    strike: `$${leg.strike}`,
    expiration: leg.expiration,
    limitPrice: `$${leg.limitPrice.toFixed(2)}`,
  }));
  return {
    count: planRows.length,
    status: pick.status,
    summary: `${headline}${pick.blockers.length ? ` Blockers: ${pick.blockers.join(" ")}` : ""} ${scan}${freshness}${note} ${pick.disclaimer}${byType}${profileClause}`,
    rows: planRows.length > 0 ? planRows : rankedRows,
    evaluations: result.strategies.evaluations,
    nameLedger: result.strategies.nameLedger,
    rejections: result.snapshot.rejections.slice(0, 15),
    quoteQuality: result.snapshot.screen.quoteQuality,
    bestTrade: pick,
    validationError: result.snapshot.validationError,
    typeRollup,
    ...(strategyProfile ? { profileRef: toProfileRef(strategyProfile) } : {}),
  };
}

/**
 * Issue #14: the NLQ discovery action. View-less: the scope resolves
 * to a universe (watchlists by default, per Decision 1), the
 * discovery runner characterizes/infers/expresses per name, and the
 * formatted setup cards are the answer. The scope key makes
 * successive runs over the same scope comparable for deltas.
 */
/**
 * Issue #1162 (epic #1096 Phase 6): run a parsed fit question through
 * the Phase 2 Name↔Strategy discovery service (via the injected
 * runner). Rows mirror the discovery result exactly — statuses,
 * provenance, and limitations ride along; nothing is re-ranked or
 * re-worded here beyond the runner's own weights-v2 notes.
 */
async function runFitDiscoveryAction(
  filters: OptionsStrategyIntent["filters"] | undefined,
  deps?: OptionsStrategyDeps,
): Promise<{ count: number; status: string; summary: string; rows: Array<Record<string, unknown>>; validationError?: string }> {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  if (!deps?.fitDiscoveryRunner) {
    return fail("Fit discovery isn't available in this context — the Name↔Strategy discovery runner (Phase 2 of epic #1096) is not wired here.");
  }
  const spec = filters?.fitDiscovery;
  if (!spec) {
    return fail("Fit discovery needs a parsed fit question — a ticker (\"what strategies fit NVDA?\") or a strategy (\"find me income names for an iron condor\").");
  }
  if (spec.direction === "name_to_strategies" && !spec.symbol) {
    return fail("Fit discovery needs a ticker: e.g. \"what strategies fit NVDA?\"");
  }
  if (spec.direction === "strategy_to_names" && !spec.structure) {
    return fail("Fit discovery needs a strategy: e.g. \"find me income names for an iron condor\"");
  }
  const request: DiscoveryModeRequest =
    spec.direction === "name_to_strategies"
      ? { direction: "name_to_strategies", symbol: spec.symbol!, outlook: spec.outlook, goalKind: spec.goalKind }
      : { direction: "strategy_to_names", structure: spec.structure!, outlook: spec.outlook, goalKind: spec.goalKind, symbols: spec.symbols };
  const outcome = await deps.fitDiscoveryRunner.run(request);
  if (!outcome.ok || !outcome.result) {
    return fail(outcome.error ?? "Fit discovery failed.");
  }
  const notes = outcome.notes.length > 0 ? ` ${outcome.notes.join(" ")}` : "";

  if (outcome.result.direction === "name_to_strategies") {
    const r = outcome.result.result;
    const rows = r.candidates.map((c, i) => ({
      rank: i + 1,
      strategy: c.label,
      structure: c.structure,
      source: c.source,
      status: c.status,
      provenance: c.provenance,
      // Null economics renders as unverified — never passed through
      // money(), whose null rendering ("Unlimited") would fabricate
      // an unlimited-loss claim for an unverified candidate.
      maxLoss: c.economics ? money(c.economics.maxLoss) : "unverified",
      netDebitCredit: !c.economics
        ? "economics unverified"
        : c.economics.netCredit > 0
          ? `${money(c.economics.netCredit)} credit`
          : `${money(c.economics.netDebit)} debit`,
      worstScenarioPnl: money(c.scenario.worstPnlTotal),
      meanScenarioPnl: money(c.scenario.meanPnlTotal),
    }));
    const limitations =
      r.limitations.length > 0 ? ` Limitations: ${r.limitations.join(" ")}` : "";
    const rejected =
      r.rejected.length > 0
        ? ` ${r.rejected.length} structure(s) rejected by the gates (${r.rejected.map((x) => x.structure).join(", ")}).`
        : "";
    return {
      count: rows.length,
      status: rows.length > 0 ? "ranked_candidates" : "no_candidates",
      summary:
        `Fit discovery for ${r.symbol} (${r.outlook}, chain provenance ${r.provenance}): ` +
        `${rows.length} candidate(s) ranked by scenario outcome, ${r.candidates.filter((c) => c.source === "composed").length} composed.` +
        `${rejected}${limitations}${notes}`,
      rows,
    };
  }

  const r = outcome.result.result;
  const rows = r.ranked.map((f, i) => ({
    rank: i + 1,
    symbol: f.symbol,
    fitScore: Number(f.fitScore.toFixed(1)),
    status: f.status,
    provenance: f.provenance,
    missingComponents: f.missingComponents.join(", ") || "none",
    maxLoss: f.economics ? money(f.economics.maxLoss) : "unverified",
  }));
  const limitations =
    r.limitations.length > 0 ? ` Limitations: ${r.limitations.join(" ")}` : "";
  const rejected =
    r.rejected.length > 0
      ? ` ${r.rejected.length} name(s) not scored (${r.rejected.map((x) => x.symbol).join(", ")}).`
      : "";
  return {
    count: rows.length,
    status: rows.length > 0 ? "ranked_candidates" : "no_candidates",
    summary:
      `Fit discovery — names for ${r.structure}: ${rows.length} name(s) ranked by strategy-fit score.` +
      `${rejected}${limitations}${notes}`,
    rows,
  };
}

async function runDiscoveryAction(
  etrade: Parameters<typeof runOptionsStrategyAction>[0],
  filters: OptionsStrategyIntent["filters"] | undefined,
  deps?: OptionsStrategyDeps,
): Promise<{ count: number; status: string; summary: string; rows: Array<Record<string, unknown>>; validationError?: string; discoveryRunId?: string }> {
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  if (!deps?.discoveryRunner) return fail("Discovery isn't wired in this context.");
  const scope: OpportunityScope = filters?.scope ?? { kind: "watchlist" };
  const resolvedScope = await resolveScopeSymbols(etrade, scope);
  if ("error" in resolvedScope) return fail(resolvedScope.error);
  const symbols = [...new Set(resolvedScope.symbols.map((s) => s.toUpperCase().trim()).filter(Boolean))];
  if (symbols.length === 0) return fail("The selected scope contained no symbols.");
  // Issue #1185: the discovery scope key is owner-scoped — without the
  // threaded authenticated login there is no owner to scope to.
  const userLogin = deps.userLogin;
  if (!userLogin) return fail("Discovery requires an authenticated user in this context.");
  const scopeKey = `nlq:${userLogin}:${scope.kind}:${
    scope.kind === "watchlist" ? (scope.name ?? "all") : symbols.join(",")
  }`;
  const outcome = await deps.discoveryRunner.run({
    symbols,
    scopeKey,
    source: "nlq",
    caps: {
      maxPlannedLoss: filters?.request?.maxPlannedLoss ?? 500,
      minRewardRisk: filters?.request?.minRewardRisk ?? 1.5,
    },
    userLogin,
  });
  return {
    count: outcome.run.counts.setups,
    status: "success",
    summary: formatDiscoveryRunSummary(outcome),
    rows: outcome.run.items as unknown as Array<Record<string, unknown>>,
    discoveryRunId: outcome.run.id,
  };
}

/**
 * Resolve an opportunity scope to its symbol list (issue #14: shared
 * by the opportunity scan and the discovery action so both read the
 * caller's watchlists / screened universe identically). Failures
 * return the user-facing message the scan has always produced.
 */
async function resolveScopeSymbols(
  etrade: Parameters<typeof runOptionsStrategyAction>[0],
  scope: OpportunityScope,
): Promise<{ symbols: string[]; scopeLabel: string } | { error: string }> {
  if (scope.kind === "symbols") {
    return { symbols: scope.symbols, scopeLabel: `${scope.symbols.length} listed symbols` };
  }
  if (scope.kind === "watchlist") {
    const lists = await etrade.getWatchlists();
    const chosen = scope.name
      ? lists.filter((l) => l.name.toLowerCase().includes(scope.name!.toLowerCase()))
      : lists;
    if (chosen.length === 0) {
      return {
        error: scope.name
          ? `No watchlist matching "${scope.name}". Say "list watchlists" to see yours.`
          : "You have no saved watchlists. Save one first, e.g. \"save these as watchlist Semis NVDA AMD AVGO\".",
      };
    }
    return {
      symbols: chosen.flatMap((l) => l.symbols),
      scopeLabel: `watchlist ${chosen.map((l) => l.name).join(", ")}`,
    };
  }
  const screened = await etrade.screenMarketsAsync(scope.filters);
  const symbols = [...screened.stocks]
    .sort((a, b) => (b.marketCap ?? 0) - (a.marketCap ?? 0))
    .slice(0, scope.maxSymbols)
    .map((s) => s.symbol);
  return {
    symbols,
    scopeLabel: `top ${symbols.length} stocks from the screened universe (${screened.stocks.length} matches)`,
  };
}

async function runOpportunityScan(
  etrade: Parameters<typeof runOptionsStrategyAction>[0],
  filters: OptionsStrategyIntent["filters"] | undefined,
  deps?: OptionsStrategyDeps,
) {
  const scanRunStore = deps?.scanRunStore;
  const fail = (message: string) => ({ count: 0, status: "invalid_request", summary: message, validationError: message, rows: [] as Array<Record<string, unknown>> });
  const scope = filters?.scope;
  if (!filters || !scope) return fail("Say where to look, e.g. \"across my Semis watchlist\" or \"across large cap stocks\".");

  let symbols: string[] = [];
  let scopeLabel = "";
  const resolvedScope = await resolveScopeSymbols(etrade, scope);
  if ("error" in resolvedScope) return fail(resolvedScope.error);
  symbols = resolvedScope.symbols;
  scopeLabel = resolvedScope.scopeLabel;
  if (symbols.length === 0) return fail("The selected scope contained no symbols.");

  // Issue #28: resolve the selected profile BEFORE scanning — an
  // unknown name (or no store in this context) fails the action rather
  // than silently scanning profile-less.
  let strategyProfile: StrategyProfile | undefined;
  if (filters.profileName) {
    const resolved = await resolveStrategyProfile(deps, filters.profileName);
    if ("error" in resolved) return fail(resolved.error);
    strategyProfile = resolved.profile;
  }

  const { symbol: statedSymbol, targetPrice, ...rest } = filters.request;
  // Issue #19: a target parsed from the question was stated for the named
  // symbol only — carry it into the scan as a scoped statedTarget so it is
  // never applied to the other scanned names.
  const template = {
    ...rest,
    ...(targetPrice !== undefined
      ? { statedTarget: statedSymbol ? { price: targetPrice, symbol: statedSymbol } : { price: targetPrice } }
      : {}),
  } as ScanRequestTemplate;
  // Issue #959: the assembled template validates through the ONE
  // shared scan-template schema (src/trading/screeningSchemas.ts)
  // before the scanner is constructed — a mis-shaped plan fails the
  // action explicitly instead of scanning under dropped fields.
  const parsedTemplate = parseScanRequestTemplate(template);
  if (!parsedTemplate.ok) return fail(parsedTemplate.error);
  // Issue #982: the scan likewise executes through the unified service
  // layer; scope resolution, the request snapshot, and scan-run
  // persistence below stay this module's (the caller's) layer.

  // Issue #16: fetch the event calendar for the scanned names so the
  // run judges event risk per name and reports coverage (the service
  // never throws; uncovered names stay unverified).
  const calendarCoverage = await getEventCalendarCoverage(symbols);
  // Issue #103: the replayable request record, built BEFORE the run
  // so the pipeline attaches it to the result before persisting it
  // (the unified execute() order: record, then save). The record
  // carries the resolved symbol batch, the template as asked
  // (pre-profile-merge), the posture/mode, and the profile selection
  // BY NAME (NLQ resolves profiles by name; the unified replay
  // resolves it the same way). Fields the question never expressed
  // stay absent.
  const requestRecord = {
    symbols,
    ...(template.thesis !== undefined ? { thesis: template.thesis } : {}),
    ...(template.targetDate !== undefined ? { targetDate: template.targetDate } : {}),
    ...(template.expectedIvDirection !== undefined ? { expectedIvDirection: template.expectedIvDirection } : {}),
    ...(template.maxPlannedLoss !== undefined ? { maxPlannedLoss: template.maxPlannedLoss } : {}),
    ...(template.minRewardRisk !== undefined ? { minRewardRisk: template.minRewardRisk } : {}),
    ...(template.allowedStrategies !== undefined ? { allowedStrategies: template.allowedStrategies } : {}),
    ...(template.perSymbol !== undefined ? { perSymbol: template.perSymbol } : {}),
    ...(template.statedTarget !== undefined ? { statedTarget: template.statedTarget } : {}),
    ...(template.minDte !== undefined ? { minDte: template.minDte } : {}),
    ...(template.maxDte !== undefined ? { maxDte: template.maxDte } : {}),
    ...(filters.riskProfile !== undefined ? { riskProfile: filters.riskProfile } : {}),
    ...(filters.mode !== undefined ? { mode: filters.mode } : {}),
    ...(filters.profileName !== undefined ? { profileName: filters.profileName } : {}),
  };

  // Issue #3186: the opportunity scan goes through the one strategy
  // pipeline instead of the direct scanOpportunities call (same
  // engine, staged). The envelope below reads the shaped result
  // unchanged - only the execution path changes. Identity is NOT
  // failed closed here (unlike the panel leg): the scanner's pinned
  // discipline (#27/#103) is that a run without an identity saves
  // unscoped - the login is never invented - and the composer
  // publishes no stage messages for such a run. Both production
  // hosts (NLQ execution, mesh door) always thread a login, so the
  // unscoped path is a test/context fallback, not a live behavior.
  const scanUserLogin = deps?.userLogin;
  const scanPipelineRunId = `nlq-scan:${crypto.randomUUID()}`;
  const scanStorage = deps?.pipelineStorage ?? memoryStageStorage();
  const scanOutcome = await runOptionsScreenWorkflow(
    {
      runId: scanPipelineRunId,
      userLogin: scanUserLogin,
      request: {
        assetClass: "options",
        runIdentity: { runId: scanPipelineRunId },
        trigger: "manual",
        classInput: {
          scan: {
            symbols,
            template: template as ScanRequestTemplate,
            options: {
              riskProfile: filters.riskProfile,
              strategyFilter: filters.strategyFilter,
              mode: filters.mode,
              eventCalendarBySymbol: Object.fromEntries(calendarCoverage.bySymbol),
              // Issue #28: the profile layers under the question's own
              // inputs. The question's thesis is explicit when the user
              // stated it (not inferred from strategy names /
              // defaults); the mode is ALWAYS explicit — NLQ derives it
              // from the question's fit phrasing (issue #23), so a
              // profile never flips which question is being answered.
              // The parser's riskProfile is NOT declared: its default
              // yields to the profile's posture. (statedTarget /
              // perSymbol are not profile fields and survive by
              // construction.)
              ...(strategyProfile
                ? {
                    profile: strategyProfile,
                    explicitFields: [...(filters.thesisInferred ? [] : ["thesis"]), "mode"],
                  }
                : {}),
            },
          },
          requestRecord,
          // Issue #3327 (carried from main's runOpportunityScan persist
          // block by the #3186 splice): the broker whose chains this run
          // reads, stamped on the saved run by the pipeline's persist
          // stage. Absent, the run records E*TRADE (the pre-provenance
          // default) — never a guess.
          broker: deps?.broker,
        },
      },
    },
    {
      stages: createScannerScreenPorts({
        agents: createStrategyScreenAgents(etrade.client),
        storage: scanStorage,
        scanRunStore,
      }),
      claims: memoryStageClaims(),
      queue: deps?.pipelineQueue ?? null,
    },
  );
  if (scanOutcome.outcome !== "completed") {
    return fail(`Options opportunity scan failed at ${scanOutcome.failedStage}: ${scanOutcome.reason}`);
  }
  const result = await scanStorage.get<OpportunityScanResult & { scanRunId?: string; persisted?: boolean }>(
    optionsArtifactKey(scanPipelineRunId, "shapeReport"),
  );
  if (!result) {
    return fail("Options opportunity scan completed without a report artifact; refusing to answer from nothing.");
  }
  // Issue #27: the shaped result already carries its save receipt
  // (scanRunId / persisted) from the persist stage; a store error
  // leaves the result intact, flagged persisted: false.
  const scanRunId = result.scanRunId;
  const persisted = result.persisted ?? false;

  // Issue #25: rows show the target in absolute dollars AND in
  // expected-move units when the chain yielded an estimate — the EM
  // distance is the cross-name comparison unit, the dollars are what
  // the user trades against.
  const targetText = (price: number | null | undefined, emUnits: number | null | undefined): string =>
    price === null || price === undefined
      ? "n/a"
      : `${money(price)}${emUnits !== null && emUnits !== undefined ? ` (${emUnits >= 0 ? "+" : ""}${emUnits.toFixed(2)} EM)` : ""}`;
  const opportunityRow = (o: OpportunityRow, i: number) => {
    const c = o.pick.best!.candidate;
    return {
      rank: i + 1,
      symbol: o.symbol,
      underlyingPrice: money(o.underlyingPrice),
      target: targetText(o.targetPrice, o.targetEmUnits),
      strategy: c.label,
      legs: c.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
      expiry: c.expirationDate,
      netDebitCredit: c.netDebit >= 0 ? `${money(c.netDebit)} debit` : `${money(-c.netDebit)} credit`,
      maxLoss: money(c.maxLoss),
      maxProfit: c.maxProfitUnbounded ? "Unlimited" : money(c.maxProfit),
      probabilityOfProfit: `${(c.modelImpliedProbabilityOfProfit * 100).toFixed(1)}%`,
      targetRewardRisk: `${c.targetRewardRisk.toFixed(2)}x`,
      score: o.score,
      status: o.pick.status.replace("_", " "),
      confidence: o.pick.confidence,
      quoteFreshness: c.dataFreshness,
    };
  };
  // Issue #23: in strategy-fit mode the rows are the fitting names — ALL
  // of them (no top-10 truncation). A fit name with an opportunity row
  // reuses it; a fit name ranked past the opportunities top-10 is built
  // from its matrix row's best overall cell instead (the cells are ordered
  // by best compositeScore, so the first cell with a best is the overall
  // best). Pick-only fields have no cell counterpart and read "n/a".
  const opportunityBySymbol = new Map(result.opportunities.map((o) => [o.symbol, o]));
  const fitRow = (fit: ScanMatrixRow, i: number) => {
    const o = opportunityBySymbol.get(fit.symbol);
    if (o) return opportunityRow(o, i);
    const best = fit.cells.find((cell) => cell.best)?.best;
    if (!best) return { rank: i + 1, symbol: fit.symbol };
    return {
      rank: i + 1,
      symbol: fit.symbol,
      underlyingPrice: "n/a",
      target: targetText(fit.targetPrice, fit.targetEmUnits),
      strategy: best.label,
      legs: best.legs.map((l) => `${l.side} ${l.quantity} ${l.strike}${l.optionType[0]}`).join(" / "),
      expiry: best.expirationDate,
      netDebitCredit: best.netDebit >= 0 ? `${money(best.netDebit)} debit` : `${money(-best.netDebit)} credit`,
      maxLoss: money(best.maxLoss),
      maxProfit: best.maxProfitUnbounded ? "Unlimited" : money(best.maxProfit),
      probabilityOfProfit: `${(best.probabilityOfProfit * 100).toFixed(1)}%`,
      targetRewardRisk: `${best.targetRewardRisk.toFixed(2)}x`,
      score: best.compositeScore,
      status: "n/a",
      confidence: "n/a",
      quoteFreshness: "n/a",
    };
  };
  const rows = result.mode === "strategy_fit"
    ? result.fits.map((fit, i) => fitRow(fit, i))
    : result.opportunities.map((o, i) => opportunityRow(o, i));
  const skippedNote = result.skipped.length ? ` ${result.skipped.length} skipped (${result.skipped.slice(0, 3).map((s) => `${s.symbol}: ${s.reason}`).join("; ")}${result.skipped.length > 3 ? "; ..." : ""}).` : "";
  const truncNote = result.truncatedSymbols ? ` Only the first ${MAX_SCAN_SYMBOLS} symbols were scanned (${result.truncatedSymbols} not scanned) to stay within request limits.` : "";
  const assumptionNote = result.assumptions.length ? ` ${result.assumptions.join(" ")}` : "";
  // Issue #22: per-type fit counts from the matrix — a name fits a type when
  // its cell for that type has screen-passing candidates and a best pick.
  // Issue #24 choice: these counts stay SCREEN-PASS evidence (the matrix is
  // the #22 evidence layer); the fit gate is the qualification layer and
  // its accounting lives in the accounting sentence / Gate segment below.
  const fitCounts = new Map<string, number>();
  for (const matrixRow of result.matrix) {
    for (const cell of matrixRow.cells) {
      if (cell.passedCount > 0 && cell.best != null) {
        fitCounts.set(cell.strategyType, (fitCounts.get(cell.strategyType) ?? 0) + 1);
      }
    }
  }
  const fitsNote = fitCounts.size
    ? ` Fits by strategy type: ${[...fitCounts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([type, count]) => `${type} ${count}`)
        .join(", ")}.`
    : "";
  // Issue #23: the summary always names the mode. Strategy-fit leads
  // with the full accounting (fit + borderline + no fit + skipped
  // partition the scanned batch); per-name-best keeps the established
  // wording plus a trailing mode label.
  // Issue #24: "fit" in that accounting is the GATED fit (fitsTotal and
  // the gate counts), not the #23 screen-pass count, and both modes gain
  // a Gate segment carrying the bucket counts and the resolved gate
  // parameters the scan was judged under.
  const matrixSkippedCount = result.matrix.filter((m) => m.verdict === "skipped").length;
  const gp = result.gateParams;
  const gatePct = (f: number) => (f * 100).toFixed(1).replace(/\.0$/, "");
  const gateNote = ` Gate: ${result.gate.fit} fit, ${result.gate.borderline} borderline, ${result.gate.noFit} no fit (min score ${gp.minCompositeScore}, min POP ${gatePct(gp.minProbabilityOfProfit)}%, ${gp.requireFresh ? "fresh quotes required" : "fresh quotes not required"}).`;
  // Issue #26: the cross-symbol type roll-up's headline — the top 3
  // types by their best candidate anywhere in the scan, with the symbol
  // that produced it. A different cut from the "Fits by strategy type:"
  // sentence above (screen-pass symbol counts per type): this one names
  // each type's single best instance. Omitted when no type has a best.
  const topTypes = result.typeRollup.filter((t) => t.bestOverall !== null).slice(0, 3);
  const typeBestNote = topTypes.length
    ? ` Best by type: ${topTypes.map((t) => `${t.strategyType} ${t.bestOverall!.compositeScore.toFixed(1)} (${t.bestOverall!.symbol})`).join("; ")}.`
    : "";
  const summary = result.mode === "strategy_fit"
    ? `Strategy fit scan over ${scopeLabel}: ${result.scanned} names accounted — ${result.fitsTotal} fit, ${result.gate.borderline} borderline, ${result.gate.noFit} no fit, ${matrixSkippedCount} skipped.${fitsNote}${skippedNote}${truncNote} Research only; verify live quotes and approve any order manually.${assumptionNote}${gateNote}${typeBestNote}`
    : `Opportunity scan over ${scopeLabel}: ${result.scanned} symbols scanned, ${result.withTrades} with a qualifying ${filters.request.thesis} trade (${filters.riskProfile} ranking).${skippedNote}${truncNote} Research only; verify live quotes and approve any order manually.${assumptionNote}${fitsNote} (mode: per-name best)${gateNote}${typeBestNote}`;
  return {
    count: rows.length,
    status: rows.length > 0 ? "ranked_opportunities" : "no_opportunities",
    summary,
    rows,
    // Issue #22: the FULL skipped list travels in the result object (the
    // summary above only shows up to 3 examples), plus the full fit matrix.
    skipped: result.skipped,
    matrix: result.matrix,
    // Issue #26: the cross-symbol per-type roll-up, same object the
    // scanner produced (and persisted runs carry).
    typeRollup: result.typeRollup,
    // Issue #23: which strategy question this scan answered.
    mode: result.mode,
    // Issue #27: persistence outcome — present only when a store was
    // supplied (contexts without one behave exactly as before). On a
    // store failure scanRunId is absent and persisted is false.
    ...(scanRunStore ? { scanRunId, persisted } : {}),
    // Issue #28: the applied profile's provenance stamp — the scan
    // result (and any persisted run) already carries it; this mirrors
    // it onto the action result.
    ...(strategyProfile ? { profileRef: result.profileRef } : {}),
  };
}
