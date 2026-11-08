/**
 * Ticker Tape Visibility Management.
 * Manages user preference for streaming benchmark quote ticker display.
 * Default is OFF per user specification.
 */
import { useEffect, useState } from "react";

export const TICKER_ENABLED_STORAGE_KEY = "cfagent_ticker_enabled";
export const TICKER_ENABLED_CHANGED_EVENT = "cfagent:ticker-enabled-changed";

/** Read persisted ticker visibility state. Defaults to false (OFF). */
export function loadTickerEnabled(): boolean {
  if (typeof window === "undefined") return false;
  try {
    const item = window.localStorage.getItem(TICKER_ENABLED_STORAGE_KEY);
    // Explicitly off by default: only true if stored as "true"
    return item === "true";
  } catch {
    return false;
  }
}

/** Persist ticker visibility state and broadcast change to same-tab and cross-tab listeners. */
export function saveTickerEnabled(enabled: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(TICKER_ENABLED_STORAGE_KEY, enabled ? "true" : "false");
    window.dispatchEvent(
      new CustomEvent(TICKER_ENABLED_CHANGED_EVENT, { detail: { enabled } })
    );
  } catch {
    // Ignore storage write failures
  }
}

/** Subscribe to ticker visibility updates. */
export function subscribeTickerEnabled(listener: (enabled: boolean) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent).detail as { enabled?: boolean } | undefined;
    if (detail && typeof detail.enabled === "boolean") {
      listener(detail.enabled);
    } else {
      listener(loadTickerEnabled());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== TICKER_ENABLED_STORAGE_KEY) return;
    listener(loadTickerEnabled());
  };
  window.addEventListener(TICKER_ENABLED_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TICKER_ENABLED_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/** Hook providing reactive ticker tape visibility state. */
export function useTickerEnabled(): boolean {
  const [enabled, setEnabled] = useState<boolean>(() => loadTickerEnabled());

  useEffect(() => {
    const unsubscribe = subscribeTickerEnabled((val) => setEnabled(val));
    return unsubscribe;
  }, []);

  return enabled;
}

