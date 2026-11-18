/**
 * Issue #2100 — the single quotes hook.
 *
 * Presentations call useMarketQuotes(symbols, enabled) and render what
 * it returns. They own no socket, no poller, no fetch, no flash timers.
 */
import { useEffect, useMemo, useState } from "react";
import { useAutoRefresh } from "../autoRefresh";
import {
  quotesService,
  type FlashDirection,
  type QuoteTransport,
  type ServiceQuote,
} from "./quotesService";

export type { FlashDirection, QuoteTransport, ServiceQuote };

export interface MarketQuotes {
  quotes: Record<string, ServiceQuote>;
  transport: QuoteTransport;
  isLive: boolean;
  flash: Record<string, FlashDirection>;
}

export function useMarketQuotes(symbols: string[], enabled = true): MarketQuotes {
  const key = useMemo(
    () =>
      symbols
        .map((s) => s.toUpperCase().trim())
        .filter(Boolean)
        .join(","),
    [symbols.join(",")],
  );
  const [snapshot, setSnapshot] = useState(() => quotesService.getSnapshot());
  // Issue #2481 — the quotes feed is a periodic live-data refresh,
  // so it subscribes only while the global auto-refresh switch is
  // ON. Unsubscribing drops the ref-count to zero, which closes
  // the socket and stops the REST fallback (quotesService), so
  // OFF also stops the server's per-connection 5s push.
  const [autoRefresh] = useAutoRefresh();
  const liveEnabled = enabled && autoRefresh.enabled;

  useEffect(() => {
    const list = key.split(",").filter(Boolean);
    if (list.length === 0) return;
    if (!liveEnabled) {
      // OFF: one initial load only — no socket, no poll. This
      // effect re-runs when the switch flips OFF, so the panel
      // shows fresh-at-toggle data, then nothing periodic.
      if (enabled) {
        let cancelled = false;
        void quotesService.loadOnce(list).then(() => {
          if (!cancelled) setSnapshot(quotesService.getSnapshot());
        });
        return () => {
          cancelled = true;
        };
      }
      return;
    }
    return quotesService.subscribe(list, setSnapshot);
  }, [key, liveEnabled, enabled]);

  const list = key.split(",").filter(Boolean);
  const filteredQuotes: Record<string, ServiceQuote> = {};
  const filteredFlash: Record<string, FlashDirection> = {};
  for (const symbol of list) {
    if (snapshot.quotes[symbol]) filteredQuotes[symbol] = snapshot.quotes[symbol];
    if (snapshot.flash[symbol]) filteredFlash[symbol] = snapshot.flash[symbol];
  }
  return {
    quotes: filteredQuotes,
    transport: snapshot.transport,
    isLive: liveEnabled && (snapshot.transport === "websocket" || snapshot.transport === "polling"),
    flash: filteredFlash,
  };
}
