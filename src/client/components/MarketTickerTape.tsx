import { useEffect, useMemo, useRef, useState } from "react";
import { useBrokerEnvironment } from "../brokerEnvironment";
import { useMarketQuotes } from "../quotes/useMarketQuotes";
import { TAPE_SYMBOLS, type QuoteSymbolMeta } from "../quotes/symbolSets";
import {
  loadTapeSelection,
  resolveTapeSymbols,
  subscribeTapeSelection,
  synthesizeTapeMeta,
  type TapeSetSelection,
} from "../quotes/symbolSetResolver";
import {
  fetchPositionSymbols,
  fetchWatchlistDetails,
} from "../accountApi";
import type { NavTabId } from "./NavigationMenu";
import { Button } from "./ui";

export interface TickerTapeQuote {
  symbol: string;
  name?: string;
  price: string;
  change: string;
  isPositive: boolean;
  type?: "stock" | "crypto" | "etf" | "index";
  rawPrice?: number;
  source?: "Alpaca" | "Yahoo Finance" | "Reference";
  timestamp?: number;
}

export interface MarketTickerTapeProps {
  onSelectSymbol?: (symbol: string) => void;
  onSelectTab?: (tab: NavTabId) => void;
  className?: string;
}

export function MarketTickerTape({ onSelectSymbol, onSelectTab, className = "" }: MarketTickerTapeProps) {
  // Issue #2116: the tape renders one resolved set. The stored selection
  // decides the source; a source that yields nothing falls back to the
  // default set (never an empty tape). Watchlist/holdings fetches resolve
  // through the same fallback on failure.
  // Issue #2482: the environment comes from the single broker module,
  // never from the retired cfagent_env key.
  const env = useBrokerEnvironment();
  const [selection, setSelection] = useState<TapeSetSelection>(() => loadTapeSelection() ?? { kind: "default" });
  const [fetchedSymbols, setFetchedSymbols] = useState<string[]>([]);
  const fetchToken = useRef(0);

  const fetchForSelection = (sel: TapeSetSelection) => {
    const token = ++fetchToken.current;
    if (sel.kind === "watchlist") {
      fetchWatchlistDetails(env, sel.id)
        .then((data) => {
          if (fetchToken.current === token) setFetchedSymbols(data.symbols ?? []);
        })
        .catch(() => {
          if (fetchToken.current === token) setFetchedSymbols([]);
        });
    } else if (sel.kind === "holdings") {
      fetchPositionSymbols(env)
        .then((symbols) => {
          if (fetchToken.current === token) setFetchedSymbols(symbols);
        })
        .catch(() => {
          if (fetchToken.current === token) setFetchedSymbols([]);
        });
    } else {
      setFetchedSymbols([]);
    }
  };

  // Resolve the stored selection on mount (watchlist/holdings need a fetch).
  useEffect(() => {
    fetchForSelection(selection);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Issue #2689: the Tape set control lives in SettingsMenu now; a
  // panel change reaches the tape through the selection event, and
  // the tape re-resolves (watchlist/holdings re-fetch) without reload.
  useEffect(() => {
    return subscribeTapeSelection((next) => {
      setSelection(next);
      fetchForSelection(next);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resolvedMetas: QuoteSymbolMeta[] = useMemo(() => {
    const symbols = resolveTapeSymbols(selection, fetchedSymbols);
    const baseBySymbol = new Map(TAPE_SYMBOLS.map((t) => [t.symbol, t]));
    const synthesized = new Map(synthesizeTapeMeta(symbols).map((m) => [m.symbol, m]));
    return symbols.map((symbol) => {
      const base = baseBySymbol.get(symbol);
      if (base) return base;
      const synth = synthesized.get(symbol)!;
      return { symbol: synth.symbol, type: synth.type, price: "—", change: "—", isPositive: true };
    });
  }, [selection, fetchedSymbols]);

  // Issue #2100: the feed lifecycle (socket, fallback, flash) lives in
  // the quotes service; the tape only renders what the hook returns.
  const {
    quotes: liveQuotes,
    transport,
    flash: flashStates,
  } = useMarketQuotes(resolvedMetas.map((t) => t.symbol));

  const quotes: Record<string, TickerTapeQuote> = {};
  for (const base of resolvedMetas) {
    const live = liveQuotes[base.symbol];
    quotes[base.symbol] = live
      ? {
          symbol: base.symbol,
          price: live.formattedPrice,
          change: live.formattedChange,
          isPositive: live.isPositive,
          type: live.type ?? base.type,
          rawPrice: live.price,
          source: live.source as TickerTapeQuote["source"],
          timestamp: live.timestamp,
        }
      : {
          symbol: base.symbol,
          price: base.price ?? "—",
          change: base.change ?? "—",
          isPositive: base.isPositive ?? true,
          type: base.type,
        };
  }

  const handleClickItem = (sym: string) => {
    if (onSelectSymbol) {
      onSelectSymbol(sym);
    } else if (onSelectTab) {
      onSelectTab("autopilot");
    }
  };

  const providerSources = Array.from(new Set(
    Object.values(quotes).flatMap((quote) =>
      (quote.source === "Alpaca" || quote.source === "Yahoo Finance") &&
      quote.timestamp !== undefined && Date.now() - quote.timestamp < 60000
        ? [quote.source]
        : []
    )
  ));
  const hasReferenceQuotes = Object.values(quotes).some((quote) => quote.source === "Reference");
  const sourceLabel = [...providerSources, ...(hasReferenceQuotes ? ["Reference"] : [])].join(" + ") || "Alpaca / Yahoo Finance";
  const liveSourceAvailable = providerSources.length > 0;
  const feedStatus = liveSourceAvailable ? "live" : transport === "offline" ? "offline" : "syncing";

  const renderTicker = (base: QuoteSymbolMeta, copy: "primary" | "duplicate") => {
    const live = quotes[base.symbol] ?? {
      symbol: base.symbol,
      price: "—",
      change: "—",
      isPositive: true,
    };
    const flash = flashStates[base.symbol];
    return (
      <Button
        key={`${copy}-${base.symbol}`}
        type="button"
        className={`ticker-tape-chip ${flash ? `flash-${flash}` : ""}`}
        onClick={() => handleClickItem(base.symbol)}
        title={`${base.symbol}: ${live.price} (${live.change}) · ${live.source || "waiting for source"} · click to inspect`}
        tabIndex={copy === "duplicate" ? -1 : undefined}
      >
        <span className="chip-symbol">{base.symbol}</span>
        <span className="chip-price">{live.price}</span>
        <span className={`chip-change ${live.isPositive ? "up" : "down"}`}>
          {live.change}
        </span>
      </Button>
    );
  };

  return (
    <div
      className={`market-ticker-tape ${className}`}
      role="region"
      aria-label="Real-Time Market Ticker"
    >
      {/* Feed Status Indicator (#2689: configuration controls live in
          SettingsMenu now; the bar keeps only the status badge). */}
      <div className={`ticker-tape-feed-badge ${feedStatus}`} title={`Feed: ${sourceLabel}`}>
        <span className={`ticker-live-dot ${feedStatus}`} />
        <span className="ticker-live-text">{liveSourceAvailable ? "LIVE" : transport === "offline" ? "OFFLINE" : "SYNCING"} · {sourceLabel}</span>
      </div>

      {/* Scrolling / Chips Strip */}
      <div className="ticker-tape-chips-viewport" aria-label="Live market quotes" aria-live="off">
        <div className="ticker-tape-marquee">
          <div className="ticker-tape-sequence">
            {resolvedMetas.map((base) => renderTicker(base, "primary"))}
          </div>
          <div className="ticker-tape-sequence" aria-hidden="true">
            {resolvedMetas.map((base) => renderTicker(base, "duplicate"))}
          </div>
        </div>
      </div>
    </div>
  );
}
