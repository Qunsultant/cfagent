import { parseOptionsStrategyIntent } from "../nlqOptionsStrategy";
import { z } from "zod";
import { STOP_WORDS_REGEX, extractOrderParameters } from "./orderParams";
import { NLQPlan, nlqPlanSchema } from "./schema";
export function planWithRules(question: string): NLQPlan {
  const qLower = question.toLowerCase();

  // 0. Fast-path for Cloudflare Agents Task Scheduling
  // 0a. List active schedules
  if (
    /\b(list|show|view|get)\s+(?:all\s+)?(?:active\s+)?(?:agent\s+)?(?:schedules?|scheduled\s+tasks?|cron\s+jobs?|alarms?)\b/i.test(question) ||
    /^(?:schedules?|scheduled\s+tasks?|list\s+schedules?)$/i.test(question.trim())
  ) {
    return {
      domain: "scheduling",
      operation: "list",
      scheduleData: {
        action: "list",
      },
      terms: "schedules",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 0b. Cancel a schedule by ID
  const cancelSchedMatch = question.match(/\b(?:cancel|delete|remove|stop|drop)\s+(?:schedule|task|alarm)\s+([a-zA-Z0-9_\-\.]+)\b/i);
  if (cancelSchedMatch) {
    const targetId = cancelSchedMatch[1].trim();
    return {
      domain: "scheduling",
      operation: "update",
      scheduleData: {
        action: "cancel",
        scheduleId: targetId,
      },
      terms: targetId,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0c. Set a reminder (delayed schedule)
  const reminderMatch =
    question.match(/\bremind\s+(?:me\s+)?(?:to\s+)?(.+?)\s+in\s+(\d+)\s*(mins?|minutes?|secs?|seconds?|hours?|hrs?)\b/i) ||
    question.match(/\bin\s+(\d+)\s*(mins?|minutes?|secs?|seconds?|hours?|hrs?)\s*,?\s*remind\s+(?:me\s+)?(?:to\s+)?(.+)\b/i);
  if (reminderMatch) {
    const isPrefix = /^\s*in\s+\d+/i.test(question);
    const num = Number(isPrefix ? reminderMatch[1] : reminderMatch[2]) || 1;
    const unit = (isPrefix ? reminderMatch[2] : reminderMatch[3]).toLowerCase();
    const taskDesc = (isPrefix ? reminderMatch[3] : reminderMatch[1]).trim();
    const multiplier = unit.startsWith("h") ? 3600 : unit.startsWith("s") ? 1 : 60;
    const delayInSeconds = num * multiplier;

    return {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "delayed",
        callback: "sendScheduledReminder",
        delayInSeconds,
        description: taskDesc,
      },
      terms: taskDesc,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0d. Schedule a recurring market screen interval or cron
  const screenIntervalMatch = question.match(/\b(?:schedule|run)\s+(?:market\s+)?(?:screen|screener|scan)\s+every\s+(\d+)\s*(mins?|minutes?|secs?|seconds?)\b/i);
  if (screenIntervalMatch) {
    const num = Number(screenIntervalMatch[1]) || 5;
    const unit = screenIntervalMatch[2].toLowerCase();
    const intervalSeconds = unit.startsWith("m") ? num * 60 : num;

    return {
      domain: "scheduling",
      operation: "create",
      scheduleData: {
        action: "create",
        scheduleType: "interval",
        callback: "autonomousMarketScreen",
        intervalSeconds,
        description: `Autonomous market screen every ${intervalSeconds} seconds`,
      },
      terms: "market_screen",
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0e. Fast-path for Cloudflare Agentic Payments & Agent Wallet
  if (
    /\b(wallet\s+status|agent\s+wallet|agentic\s+wallet|wallet\s+balance|micropayments?|x402|mpp)\b/i.test(question) ||
    /\b(set|update|change)\s+(?:the\s+)?(?:auto\s*[-]?\s*approve\s+)?(?:agent\s+)?limit\b/i.test(question)
  ) {
    if (/\b(set|update|change)\s+(?:the\s+)?(?:auto\s*[-]?\s*approve\s+)?(?:agent\s+)?limit\b/i.test(question)) {
      const limitMatch = question.match(/\$?\s*(\d+(?:\.\d+)?)/);
      const limitUSD = limitMatch ? parseFloat(limitMatch[1]) : 0.05;
      return {
        domain: "agentic_payments",
        operation: "update",
        agenticPaymentsData: {
          action: "set_limit",
          limitUSD,
        },
        terms: "set_limit",
        role: "any",
        since: null,
        limit: 1,
      };
    }
    if (/\b(transactions?|ledger|history|payments?)\b/i.test(question)) {
      return {
        domain: "agentic_payments",
        operation: "list",
        agenticPaymentsData: {
          action: "micropayments_list",
        },
        terms: "micropayments",
        role: "any",
        since: null,
        limit: 25,
      };
    }
    return {
      domain: "agentic_payments",
      operation: "list",
      agenticPaymentsData: {
        action: "wallet_status",
      },
      terms: "wallet_status",
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 0f. Fast-path for Paid Trading Services with Agentic Payment
  if (/\b(paid\s+options?\s+screen|premium\s+options?\s+screen|paid\s+research|premium\s+market\s+research)\b/i.test(question)) {
    const isResearch = /\b(research)\b/i.test(question);
    const symMatch = question.match(/\b(?:for|on|symbol|ticker)\s+([a-zA-Z]{1,5})\b/i);
    const symbol = symMatch ? symMatch[1].toUpperCase() : undefined;
    const underlyingLimitMatch = question.match(/(?:up to|max(?:imum)?|limit to)\s*(\d+)\s*(?:underlyings|symbols|stocks|tickers)\b/i);
    const contractType = /\bputs?\b/i.test(question) && !/\bcalls?\b/i.test(question)
      ? "PUT" as const
      : /\bcalls?\b/i.test(question) && !/\bputs?\b/i.test(question)
      ? "CALL" as const
      : "BOTH" as const;
    return {
      domain: "agentic_payments",
      operation: "create",
      agenticPaymentsData: {
        action: isResearch ? "paid_research" : "paid_scan",
        ...(symbol ? { symbol } : {}),
        ...(underlyingLimitMatch ? { maxUnderlyings: Number(underlyingLimitMatch[1]) } : {}),
        contractType,
      },
      terms: symbol || "paid_options_screen",
      role: "any",
      since: null,
      limit: 10,
    };
  }

  // 0g. Fast-path for social brief provisioning (#1077 Phase 5b
  // slice 2): ONLY an explicit imperative request to set the day's
  // social post content. The patterns require a set/use verb, the
  // words "social brief|post", and content after a separator — a
  // question, a discussion, or a report request never matches, so
  // general NLQ queries can never mint a brief. The separator is
  // verb-sensitive on purpose: "use the social brief to explain X"
  // is instrumental (use the EXISTING brief as material), not a
  // set, so "use" accepts only "as"/":" while "set" accepts
  // "to"/"as"/":". Broader phrasings ("post this to social", "tweet
  // this") deliberately do NOT match; widening the phrasing is a
  // product decision, not a pattern tweak. Empty content falls
  // through (never an empty brief).
  const socialBriefMatch =
    question.match(
      /^\s*set(?:\s+the)?\s+(?:(today'?s|tomorrow'?s)\s+)?social\s+(?:brief|post)(?:\s+for\s+(today|tomorrow))?\s*(?:to|as|:)\s*([\s\S]+?)\s*$/i,
    ) ||
    question.match(
      /^\s*use(?:\s+the)?\s+(?:(today'?s|tomorrow'?s)\s+)?social\s+(?:brief|post)(?:\s+for\s+(today|tomorrow))?\s*(?:as|:)\s*([\s\S]+?)\s*$/i,
    );
  if (socialBriefMatch) {
    const content = (socialBriefMatch[3] ?? "").trim();
    const dayWord = socialBriefMatch[1] ?? socialBriefMatch[2];
    if (content) {
      return {
        domain: "social",
        operation: "create",
        socialData: {
          action: "set_brief",
          text: content,
          dayOffset: dayWord?.toLowerCase().startsWith("tomorrow") ? 1 : 0,
        },
        terms: "social brief",
        role: "any",
        since: null,
        limit: 25,
      };
    }
  }

  // 1. Fast-path for Category addition or update (check before generic tables)
  const addCatMatch = question.match(/\b(?:add|create|insert|new)\s+category\s+["']?([^"']+)["']?/i);
  if (addCatMatch) {
    const rawName = addCatMatch[1].replace(/\bto\s+categories\s+tables?\b/i, "").trim();
    return {
      domain: "category_mutation",
      operation: "create",
      categoryData: {
        action: "create",
        name: rawName,
        description: `Category for ${rawName} referral and partner links`,
        icon: "🏷️",
      },
      terms: rawName,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // Strategy-ledger requests must win over generic "table" and "ledger" queries.
  const strategyIntent = parseOptionsStrategyIntent(question);
  if (strategyIntent) {
    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: strategyIntent.action,
        symbol: strategyIntent.filters.request.symbol,
        filters: strategyIntent.filters as unknown as Record<string, any>,
        strategyFilter: strategyIntent.filters.strategyFilter as Record<string, any> | undefined,
        request: strategyIntent.filters.request as Record<string, any> | undefined,
        scope: strategyIntent.filters.scope as Record<string, any> | undefined,
      },
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 2. Fast-path intent detection for database tables & schema
  if (/\b(tables?|schema|databases?|columns?|catalog)\b/i.test(question) && !/\b(messages?|chats?|categories)\b/i.test(question)) {
    return {
      domain: "tables",
      operation: "list",
      terms: "",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3. Fast-path for Table data queries
  if (/\b(categories|referrals|ads|external ads|transactions|ledger|events|memory)\b/i.test(question)) {
    let target = "mas_categories";
    if (/\b(categories)\b/i.test(question)) {
      target = "mas_categories";
    } else if (/\b(referrals?|links?)\b/i.test(question)) {
      target = "mas_referrals";
    } else if (/\b(external\s*ads?)\b/i.test(question)) {
      target = "mas_external_ads";
    } else if (/\b(ads?|marketplace)\b/i.test(question)) {
      target = "mas_ads";
    } else if (/\b(transactions?|payments?|charges?|refunds?)\b/i.test(question)) {
      target = "mas_transactions";
    } else if (/\b(events?|audit)\b/i.test(question)) {
      target = "mas_events";
    } else if (/\b(memory|facts?)\b/i.test(question)) {
      target = "mas_memory";
    }

    return {
      domain: "table_data",
      operation: "list",
      targetTable: target,
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 50,
    };
  }

  // 3b. Fast-path for Watchlists (Save / Create / List)
  let saveWatchlistMatch: { name: string; symbolsText?: string } | null = null;

  const m1 = question.match(/\bsave\s+(.+?)\s+(?:as|to|into)\s+(?:a\s+)?watchlist\s*(?:named\s+|called\s+)?["']?([^"']+)["']?/i);
  if (m1) {
    saveWatchlistMatch = { name: m1[2].trim(), symbolsText: m1[1].trim() };
  } else {
    const m2 = question.match(/\bsave\s+(?:as|to|into)\s+(?:a\s+)?watchlist\s*(?:named\s+|called\s+)?["']?([^"']+)["']?/i);
    if (m2) {
      saveWatchlistMatch = { name: m2[1].trim() };
    } else {
      const m3 = question.match(/\bcreate\s+(?:a\s+)?watchlist\s*(?:named\s+|called\s+)?["']?([^"'\s]+)["']?(?:\s+with\s+(.+))?/i);
      if (m3) {
        saveWatchlistMatch = { name: m3[1].trim(), symbolsText: m3[2]?.trim() };
      }
    }
  }

  if (saveWatchlistMatch) {
    const rawName = saveWatchlistMatch.name;
    const symbolsRaw = saveWatchlistMatch.symbolsText || "";
    const explicitSymbols = symbolsRaw
      ? symbolsRaw
          .split(/[,\s]+/)
          .map((s) => s.replace(/[^A-Za-z]/g, "").toUpperCase())
          .filter((s) => s.length >= 1 && s.length <= 5 && !["THESE", "THE", "ALL", "SCREENED", "STOCKS", "RESULTS", "OPTIONS"].includes(s))
      : [];

    return {
      domain: "trading",
      operation: "create",
      tradingData: {
        action: "watchlist_save",
        watchlistName: rawName,
        symbols: explicitSymbols,
      },
      terms: rawName,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  if (/\b(list|show|view|get)\s+(?:all\s+)?(?:my\s+)?watchlists?\b/i.test(question) || /^(?:watchlists?|my\s+watchlists?)$/i.test(question.trim())) {
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "watchlist_list",
      },
      terms: "watchlists",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3b-2. Fast-path for Options Flow Queries
  if (
    /\b(options?\s+flows?|unusual\s+options?|options?\s+sweeps?|institutional\s+flows?|bullish\s+flows?|bearish\s+flows?)\b/i.test(question) ||
    (/\bflows?\b/i.test(question) && /\b(calls?|puts?|sweeps?|blocks?|options?)\b/i.test(question))
  ) {
    const symMatch = question.match(/\b(?:for|on|in)\s+([A-Za-z]{1,5})\b/i) || question.match(/\b([A-Za-z]{1,5})\s+(?:options?\s+)?flows?\b/i);
    const sym = symMatch && !["FLOW", "FLOWS", "OPTION", "OPTIONS", "SWEEP", "SWEEPS", "BLOCK", "BLOCKS", "CALL", "CALLS", "PUT", "PUTS"].includes(symMatch[1].toUpperCase())
      ? symMatch[1].toUpperCase()
      : undefined;

    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: "options_flow",
        symbol: sym,
        filters: {
          symbol: sym,
          bullishOnly: /\bbullish\b/i.test(question),
          bearishOnly: /\bbearish\b/i.test(question),
          sweepsOnly: /\bsweeps?\b/i.test(question),
          unusualOnly: /\bunusual\b/i.test(question),
        },
      },
      terms: sym ? `${sym} options flow` : "options flow",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3c. Fast-path for Options Screening
  if (
    (/\b(options?|contracts?)\b/i.test(question) && /\b(screen|screener|scan|scanning|scanned|filter|chains?)\b/i.test(question)) ||
    /\b(call|put)\s+options?\b/i.test(question) ||
    (/\boptions?\b/i.test(question) && /\b(delta|iv|implied\s+volatility|gamma|theta|dte|strike|moneyness)\b/i.test(question)) ||
    /\b(max\s*profit|max\s*loss|credit\s*spread|debit\s*spread|iron\s*condor|straddle|strangle|underlyings?)\b/i.test(question)
  ) {
    const optFilters: Record<string, any> = {};

    if (/\b(call|calls)\b/i.test(question) && !/\b(put|puts)\b/i.test(question)) optFilters.contractType = "CALL";
    else if (/\b(put|puts)\b/i.test(question) && !/\b(call|calls)\b/i.test(question)) optFilters.contractType = "PUT";
    else optFilters.contractType = "BOTH";

    // Underlying symbol e.g. "for NVDA", "NVDA options"
    const symMatch = question.match(/\b(?:for|on|in)\s+([A-Za-z]{1,5})\b/i) || question.match(/\b([A-Za-z]{1,5})\s+options?\b/i);
    if (symMatch && !["CALL", "PUTS", "CALLS", "PUT", "TECH", "RSI", "MACD"].includes(symMatch[1].toUpperCase())) {
      optFilters.underlyingSymbols = [symMatch[1].toUpperCase()];
    }

    if (/\b(tech|technology)\b/i.test(question)) optFilters.sector = "Technology";
    if (/\b(semiconductor|semis|chips)\b/i.test(question)) optFilters.sector = "Semiconductors";

    // Delta filters
    const deltaOverMatch = question.match(/delta\s*(?:>|over|greater than|above)\s*(0?\.\d+|\d+)/i);
    if (deltaOverMatch) optFilters.minDelta = Number(deltaOverMatch[1]) > 1 ? Number(deltaOverMatch[1]) / 100 : Number(deltaOverMatch[1]);
    const deltaUnderMatch = question.match(/delta\s*(?:<|under|less than|below)\s*(0?\.\d+|\d+)/i);
    if (deltaUnderMatch) optFilters.maxDelta = Number(deltaUnderMatch[1]) > 1 ? Number(deltaUnderMatch[1]) / 100 : Number(deltaUnderMatch[1]);

    const gammaOverMatch = question.match(/gamma\s*(?:>|over|greater than|above)\s*(-?\d*\.?\d+)/i);
    if (gammaOverMatch) optFilters.minGamma = Number(gammaOverMatch[1]);
    const gammaUnderMatch = question.match(/gamma\s*(?:<|under|less than|below)\s*(-?\d*\.?\d+)/i);
    if (gammaUnderMatch) optFilters.maxGamma = Number(gammaUnderMatch[1]);
    const thetaOverMatch = question.match(/theta\s*(?:>|over|greater than|above)\s*(-?\d*\.?\d+)/i);
    if (thetaOverMatch) optFilters.minTheta = Number(thetaOverMatch[1]);
    const thetaUnderMatch = question.match(/theta\s*(?:<|under|less than|below)\s*(-?\d*\.?\d+)/i);
    if (thetaUnderMatch) optFilters.maxTheta = Number(thetaUnderMatch[1]);

    const dteRangeMatch = question.match(/(\d+)\s*(?:to|-)\s*(\d+)\s*(?:dte|days? to expiration)/i);
    if (dteRangeMatch) {
      optFilters.minDte = Number(dteRangeMatch[1]);
      optFilters.maxDte = Number(dteRangeMatch[2]);
    } else {
      const minDteMatch = question.match(/(?:dte\s*(?:>|over|greater than|above)|(?:over|above|at least)\s*)(\d+)\s*(?:dte|days? to expiration)?/i);
      const maxDteMatch = question.match(/(?:dte\s*(?:<|under|less than|below)|(?:under|below|within|at most)\s*)(\d+)\s*(?:dte|days? to expiration)?/i);
      if (minDteMatch) optFilters.minDte = Number(minDteMatch[1]);
      if (maxDteMatch) optFilters.maxDte = Number(maxDteMatch[1]);
    }

    const minVolumeMatch = question.match(/volume\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
    if (minVolumeMatch) optFilters.minVolume = Number(minVolumeMatch[1].replace(/,/g, ""));
    const minOiMatch = question.match(/(?:open\s*interest|oi)\s*(?:>|over|greater than|above)\s*(\d[\d,]*)/i);
    if (minOiMatch) optFilters.minOpenInterest = Number(minOiMatch[1].replace(/,/g, ""));
    const maxSpreadMatch = question.match(/spread\s*(?:<|under|below|at most)\s*(\d+(?:\.\d+)?)\s*%?/i);
    if (maxSpreadMatch) optFilters.maxSpreadPct = Number(maxSpreadMatch[1]);
    const quoteAgeMatch = question.match(/quote\s*age\s*(?:<|under|below|at most)\s*(\d+)\s*(?:s|seconds?)/i);
    if (quoteAgeMatch) optFilters.maxQuoteAgeSeconds = Number(quoteAgeMatch[1]);
    const maxUnderlyingsMatch = question.match(/(?:up to|max(?:imum)?|limit to)\s*(\d+)\s*(?:underlyings|symbols|stocks|tickers)\b/i);
    if (maxUnderlyingsMatch) optFilters.maxUnderlyings = Number(maxUnderlyingsMatch[1]);
    const contractLimitMatch = question.match(/(?:top|limit(?: to)?|up to)\s*(\d+)\s*(?:contracts|options)\b/i);
    if (contractLimitMatch) optFilters.limit = Number(contractLimitMatch[1]);

    // IV filters
    const ivOverMatch = question.match(/iv\s*(?:>|over|above|greater than)\s*(\d+)%?/i) || question.match(/implied\s+volatility\s*(?:>|over|above)\s*(\d+)%?/i);
    if (ivOverMatch) optFilters.minImpliedVolatility = Number(ivOverMatch[1]) / 100;
    if (/\b(high\s*iv|unusual\s*volume)\b/i.test(question)) optFilters.minImpliedVolatility = 0.50;

    // Moneyness
    if (/\b(itm|in the money)\b/i.test(question)) optFilters.moneyness = "ITM";
    else if (/\b(otm|out of the money)\b/i.test(question)) optFilters.moneyness = "OTM";
    else if (/\b(atm|at the money)\b/i.test(question)) optFilters.moneyness = "ATM";

    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: "options_screen",
        filters: optFilters,
      },
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 3b. Fast-path for Platform Capabilities, Discovery & General Assistance
  const isCapabilitiesQuery =
    /\b(capabilities|capability|features?|workflows?|what\s+can\s+(?:you|this\s+desk|the\s+agent|the\s+platform)\s+do|how\s+to\s+use|help|overview|menu|what\s+do\s+you\s+support|what\s+are\s+the\s+capabilities)\b/i.test(question) ||
    /^(?:find|search|explore|help|lookup|start|menu|show\s+me|show)$/i.test(question.trim());

  const isExplicitConversationQuery = /\b(messages?|chat\s+history|transcripts?|conversation\s+records?|conversations?|user\s+said|i\s+said|what\s+did\s+i\s+ask)\b/i.test(question);

  if (isCapabilitiesQuery && !isExplicitConversationQuery) {
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "capabilities",
      },
      terms: "platform capabilities",
      role: "any",
      since: null,
      limit: 14,
    };
  }

  // 4. Fast-path for E*TRADE Stock Screening / Market Scanning
  const isOptionsOrStrategy = /\b(options?|contracts?|chains?|calls?|puts?|delta|dte|strike|iv|implied\s+volatility|max\s*profit|max\s*loss|spreads?|condors?|straddles?|strangles?|underlyings?|strateg\w*)\b/i.test(question);
  if (
    !isOptionsOrStrategy &&
    (/\b(screen|screener|scan|scanning|scanned|breakout|oversold|overbought|gainers?|losers?|momentum)\b/i.test(question) ||
    ( /\b(stocks?|equities|listings)\b/i.test(question) && /\b(tech|semiconductor|rsi|macd|pe|p\/e|cap|volume|dividend|growth|price|priced|exchange|nasdaq|nyse|amex)\b/i.test(question)))
  ) {
    const filters: Record<string, any> = {};
    // Keep unsupported filters in the plan so the listing provider can explain why they cannot be applied.
    if (/\b(tech|technology)\b/i.test(question)) filters.sector = "Technology";
    if (/\b(semiconductor|semis|chips)\b/i.test(question)) filters.sector = "Semiconductors";
    if (/\b(cloud|enterprise|software)\b/i.test(question)) filters.sector = "Enterprise Software";
    if (/\b(crypto|bitcoin|fintech)\b/i.test(question)) filters.sector = "Fintech & Crypto";
    if (/\b(financials?|finance|banks?)\b/i.test(question)) filters.sector = "Financial";
    if (/\b(healthcare?|pharma|biotech)\b/i.test(question)) filters.sector = "Healthcare";
    if (/\b(energy|oil|gas)\b/i.test(question)) filters.sector = "Energy";

    const rsiUnderMatch = question.match(/rsi\s*(?:<|under|less than|below)\s*(\d+)/i);
    if (rsiUnderMatch) filters.maxRsi = Number(rsiUnderMatch[1]);
    const rsiOverMatch = question.match(/rsi\s*(?:>|over|greater than|above)\s*(\d+)/i);
    if (rsiOverMatch) filters.minRsi = Number(rsiOverMatch[1]);

    const priceRangeMatch = question.match(/\b(?:price|priced|trading)\s+(?:between|from)\s*\$?([\d,.]+)\s*(?:and|to|-)\s*\$?([\d,.]+)/i);
    if (priceRangeMatch) {
      filters.minPrice = Number(priceRangeMatch[1].replace(/,/g, ""));
      filters.maxPrice = Number(priceRangeMatch[2].replace(/,/g, ""));
    } else {
      const minPriceMatch = question.match(/\b(?:price|priced|trading)\s*(?:>|over|above|at least|greater than)\s*\$?([\d,.]+)/i);
      const maxPriceMatch = question.match(/\b(?:price|priced|trading)\s*(?:<|under|below|at most|less than)\s*\$?([\d,.]+)/i);
      if (minPriceMatch) filters.minPrice = Number(minPriceMatch[1].replace(/,/g, ""));
      if (maxPriceMatch) filters.maxPrice = Number(maxPriceMatch[1].replace(/,/g, ""));
    }

    const marketCapMatch = question.match(/market\s*cap(?:italization)?\s*(?:>|over|above|at least|greater than)\s*\$?([\d,.]+)\s*(t|trillion|b|billion|m|million)?/i);
    if (marketCapMatch) {
      const amount = Number(marketCapMatch[1].replace(/,/g, ""));
      const unit = (marketCapMatch[2] || "b").toLowerCase();
      filters.minMarketCap = unit.startsWith("t") ? amount * 1000 : unit.startsWith("m") ? amount / 1000 : amount;
    }
    const exchangeMatch = question.match(/\b(nasdaq|nyse|amex)\b/i);
    if (exchangeMatch) filters.exchange = exchangeMatch[1].toUpperCase();

    const hasGainers = /\b(gainer|gainers|up|green)\b/i.test(question);
    const hasLosers = /\b(loser|losers|down|red)\b/i.test(question);
    const isMoversIntent = (hasGainers && hasLosers) || /\b(market\s*movers?|biggest\s*movers?|top\s*movers?)\b/i.test(question);

    if (isMoversIntent) {
      filters.gainersLosers = "movers";
      delete filters.gainersOnly;
      delete filters.losersOnly;
    } else if (hasGainers) {
      filters.gainersOnly = true;
    } else if (hasLosers) {
      filters.losersOnly = true;
    }

    const resultLimitMatch = question.match(/\b(?:top|limit(?: to)?|show)\s+(\d+)\s+(?:stocks?|equities|listings)\b/i);
    if (resultLimitMatch) filters.limit = Number(resultLimitMatch[1]);

    return {
      domain: "trading",
      operation: "search",
      tradingData: {
        action: "screen",
        filters,
      },
      terms: question.replace(STOP_WORDS_REGEX, " ").trim(),
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 5. Fast-path for Market Data Research & Quoting (Yahoo Finance / Alpaca)
  if (/\b(yfinance|yahoo\s*finance|alpaca|market\s*data|fundamentals?|valuation|research|compare|snapshot|pe\s*ratio|p\/e|peg)\b/i.test(question)) {
    const excludeWords = new Set(["MARKET", "DATA", "USD", "FOR", "ON", "AND", "THE", "GET", "LIVE", "PE", "PEG", "API", "APIS", "NBBO", "DEEP", "RUN", "STOCK", "SHARE", "PRICE", "QUOTE", "WITH", "USING"]);
    const allUpperMatches = Array.from(question.matchAll(/\b([A-Za-z0-9\/\.\-]{1,8})\b/g)).map(m => m[1]);
    const validTickers = allUpperMatches.filter(w => /^[A-Z0-9\/\.\-]+$/.test(w) && !excludeWords.has(w.toUpperCase()));
    
    let sym = validTickers.length > 0 ? validTickers[0].toUpperCase() : "NVDA";
    if (validTickers.length === 0) {
      const explicitMatch = question.match(/\b(?:ticker|symbol|stock|asset|shares?\s+of|on|for)\s+([A-Za-z0-9\/\.\-]+)\b/i);
      if (explicitMatch && !excludeWords.has(explicitMatch[1].toUpperCase())) {
        sym = explicitMatch[1].toUpperCase();
      }
    }

    if (/\b(compare|comparison|versus|vs)\b/i.test(question)) {
      const symMatches = Array.from(question.matchAll(/\b([A-Z]{1,5})\b/g)).map(m => m[1]);
      const uniqueSyms = Array.from(new Set(symMatches.filter(s => !excludeWords.has(s.toUpperCase()))));
      const symbols = uniqueSyms.length >= 2 ? uniqueSyms.slice(0, 4) : [sym, "AMD"];
      return {
        domain: "research",
        operation: "search",
        researchData: {
          action: "compare",
          symbols,
          provider: "hybrid",
        },
        terms: symbols.join(" "),
        role: "any",
        since: null,
        limit: 10,
      };
    }

    let action: "quote" | "fundamentals" | "bars" | "report" | "snapshot" | "compare" = "report";
    let provider: "yfinance" | "alpaca" | "hybrid" = "hybrid";

    if (/\b(snapshot|order\s*book|depth)\b/i.test(question)) {
      action = "snapshot";
      provider = "alpaca";
    } else if (/\b(quote|price|spread)\b/i.test(question) && !/\b(research|analysis|report)\b/i.test(question)) {
      action = "quote";
      provider = /\balpaca\b/i.test(question) ? "alpaca" : /\b(yahoo|yfinance)\b/i.test(question) ? "yfinance" : "hybrid";
    } else if (/\b(fundamentals?|p\/e|peg|market\s*cap|balance\s*sheet)\b/i.test(question) && !/\b(research|analysis|report)\b/i.test(question)) {
      action = "fundamentals";
      provider = "yfinance";
    } else {
      action = "report";
      provider = "hybrid";
    }

    return {
      domain: "research",
      operation: "search",
      researchData: {
        action,
        symbol: sym,
        provider,
      },
      terms: sym,
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 6. Fast-path for E*TRADE Stock Quote
  const quoteExcludeWords = new Set(["FOR", "OF", "ON", "THE", "PLEASE", "REQUEST", "CHECK", "WHAT", "SHOW", "AND", "WITH", "REQUE"]);
  const quoteMatch =
    question.match(/(?:quote|price|ticker|trading at)\s*(?::|for|of|on|request)*\s+([A-Za-z]{1,5})\b/i) ||
    question.match(/\b([A-Za-z]{1,5})\s+(?:quote|price|ticker|trading at)\b/i);
  if (quoteMatch && !/\b(messages?|categories|tables?)\b/i.test(question)) {
    let symbol = quoteMatch[1].toUpperCase();
    if (quoteExcludeWords.has(symbol)) {
      const fallbackTicker = Array.from(question.matchAll(/\b([A-Z]{2,5})\b/g)).map(m => m[1]).find(t => !quoteExcludeWords.has(t));
      if (fallbackTicker) {
        symbol = fallbackTicker;
      }
    }
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "quote",
        symbol,
      },
      terms: symbol,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 6b. Fast-path for conversational order approval & execution (Strict HITL)
  const approveMatch = question.match(/^\s*(?:approve|authorize|confirm|execute)\s+(?:order\s+)?([a-zA-Z0-9_\-]+)\s*$/i);
  if (approveMatch) {
    const targetOrderId = approveMatch[1].trim();
    return {
      domain: "trading",
      operation: "update",
      tradingData: {
        action: "execute_order",
        symbol: targetOrderId,
      },
      terms: `execute ${targetOrderId}`,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 6c. Fast-path for conversational order cancellation
  const cancelMatch = question.match(/^\s*(?:cancel|reject|abort|dismiss)\s+(?:order\s+)?([a-zA-Z0-9_\-]+)\s*$/i);
  if (cancelMatch) {
    const targetOrderId = cancelMatch[1].trim();
    return {
      domain: "trading",
      operation: "update",
      tradingData: {
        action: "cancel_order",
        symbol: targetOrderId,
      },
      terms: `cancel ${targetOrderId}`,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 7. Fast-path for E*TRADE Order Proposal / Preview
  const orderParams = extractOrderParameters(question);
  if (orderParams) {
    return {
      domain: "trading",
      operation: "create",
      tradingData: {
        action: "preview_order",
        symbol: orderParams.symbol,
        orderAction: orderParams.orderAction,
        quantity: orderParams.quantity,
        orderType: orderParams.orderType,
        limitPrice: orderParams.limitPrice,
        relativePriceOffsetPercent: orderParams.relativePriceOffsetPercent,
        relativePriceDescription: orderParams.relativePriceDescription,
        ...(orderParams.takeProfitPercent !== undefined
          ? { takeProfitPercent: orderParams.takeProfitPercent }
          : {}),
        ...(orderParams.stopLossPercent !== undefined
          ? { stopLossPercent: orderParams.stopLossPercent }
          : {}),
      },
      terms: `${orderParams.orderAction} ${orderParams.quantity} ${orderParams.symbol}`,
      role: "any",
      since: null,
      limit: 1,
    };
  }

  // 8. Fast-path for E*TRADE Portfolio & Positions
  if (/\b(positions?|portfolio|holdings?|balance|brokerage account|shares i own)\b/i.test(question) && !/\b(messages?|categories)\b/i.test(question)) {
    return {
      domain: "trading",
      operation: "list",
      tradingData: {
        action: "positions",
      },
      terms: "portfolio positions",
      role: "any",
      since: null,
      limit: 25,
    };
  }

  // 9. Heuristic conversation search fallback
  const isCount = /\b(how many|count|total)\b/i.test(question);
  const isAssistant = /\b(assistant|bot|responses?|answers?)\b/i.test(question);
  const isUser = /\b(user|questions?|prompts?|i asked|i said)\b/i.test(question);
  const cleanTerms = question.replace(STOP_WORDS_REGEX, " ").trim();

  return {
    domain: "conversation",
    operation: isCount ? "count" : "list",
    terms: cleanTerms.slice(0, 100),
    role: isAssistant ? "assistant" : isUser ? "user" : "any",
    since: null,
    limit: 25,
    planSource: "fallback",
  };
}

/**
 * Tier 2: Calls Cloudflare Workers AI with structured output constraint
 * matching the exact API schema (nlqPlanSchema).
 */
