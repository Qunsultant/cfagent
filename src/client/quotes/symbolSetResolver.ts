/**
 * Issue #2116 (slice D) — the tape's symbol-set resolution.
 *
 * The tape renders one resolved set. The stored selection decides the
 * source; a source that yields nothing falls back to the default set,
 * so the tape is never empty. Pure functions here (node-testable); the
 * tape owns fetching (watchlists, holdings) and persistence wiring.
 */
import { TAPE_SYMBOLS } from "./symbolSets";
import { parseSymbolList } from "../accountApi";

/** Hard cap: the stream subscribes per symbol, so sets stay bounded. */
export const TAPE_SET_CAP = 20;

export const TAPE_SET_STORAGE_KEY = "cfagent_tape_symbol_set";

/** Same-tab broadcast for tape-set changes (#2689, mirrors autoRefresh). */
export const TAPE_SELECTION_CHANGED_EVENT = "cfagent:tape-selection-changed";

function dispatchTapeSelectionChanged(selection: TapeSetSelection): void {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(TAPE_SELECTION_CHANGED_EVENT, { detail: { ...selection } }),
    );
  } catch {
    // Dispatch failure must never break the save itself.
  }
}

/**
 * Subscribe to tape-set changes (panel save, or another tab via the
 * storage event). The tape and the panel both use this so a panel
 * change reaches the tape without a reload.
 */
export function subscribeTapeSelection(
  listener: (selection: TapeSetSelection) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent).detail as TapeSetSelection | undefined;
    if (detail && typeof detail.kind === "string") listener(detail);
    else listener(loadTapeSelection() ?? { kind: "default" });
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== TAPE_SET_STORAGE_KEY) return;
    listener(loadTapeSelection() ?? { kind: "default" });
  };
  window.addEventListener(TAPE_SELECTION_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(TAPE_SELECTION_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

export type TapePresetId = "default" | "indices" | "mega-cap" | "crypto";

export type TapeSetSelection =
  | { kind: "default" }
  | { kind: "preset"; preset: Exclude<TapePresetId, "default"> }
  | { kind: "custom"; text: string }
  | { kind: "watchlist"; id: string | number; name?: string }
  | { kind: "holdings" };

/** Presets derive from existing sets only — no invented symbols. */
export const TAPE_PRESETS: Record<TapePresetId, string[]> = {
  default: TAPE_SYMBOLS.map((t) => t.symbol),
  indices: ["SPY", "QQQ", "DIA"],
  "mega-cap": ["NVDA", "AAPL", "MSFT", "TSLA", "AMD", "AMZN", "META", "GOOGL"],
  crypto: ["BTC/USD", "ETH/USD", "SOL/USD"],
};

export function normalizeSymbols(symbols: string[]): string[] {
  return parseSymbolList(symbols.join(","));
}

function cap(symbols: string[]): string[] {
  return symbols.slice(0, TAPE_SET_CAP);
}

/**
 * Resolve the stored selection to the symbols the tape subscribes to.
 * `fetched` carries the caller-fetched symbols for watchlist/holdings
 * kinds; it is ignored for preset/custom/default. Empty resolution
 * falls back to the default set — the tape never renders empty.
 */
export function resolveTapeSymbols(
  selection: TapeSetSelection | null | undefined,
  fetched?: string[],
): string[] {
  const fallback = TAPE_PRESETS.default;
  if (!selection || selection.kind === "default") return fallback;
  if (selection.kind === "preset") return cap(TAPE_PRESETS[selection.preset] ?? fallback);
  if (selection.kind === "custom") {
    const parsed = cap(parseSymbolList(selection.text));
    return parsed.length > 0 ? parsed : fallback;
  }
  // watchlist / holdings: fetched symbols, or the default when the
  // fetch came back empty or failed (the caller passes [] then).
  const resolved = cap(normalizeSymbols(fetched ?? []));
  return resolved.length > 0 ? resolved : fallback;
}

/** Display-fallback metadata for resolved symbols (live ticks override). */
export function synthesizeTapeMeta(symbols: string[]): { symbol: string; type: "stock" | "crypto" | "etf" | "index" }[] {
  return symbols.map((symbol) => ({
    symbol,
    type: symbol.includes("/")
      ? "crypto"
      : ["SPY", "QQQ", "DIA", "IWM"].includes(symbol)
        ? "etf"
        : ["^VIX", "^TNX"].includes(symbol)
          ? "index"
          : "stock",
  }));
}

export interface TapeSetStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function defaultStorage(): TapeSetStorage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    // Non-DOM environment: no persistence.
  }
  return null;
}

export function loadTapeSelection(storage?: TapeSetStorage | null): TapeSetSelection | null {
  const store = storage ?? defaultStorage();
  if (!store) return null;
  try {
    const raw = store.getItem(TAPE_SET_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as TapeSetSelection;
    if (!parsed || typeof parsed.kind !== "string") return null;
    if (parsed.kind === "preset" && !["indices", "mega-cap", "crypto"].includes(parsed.preset)) return null;
    if (parsed.kind === "custom" && typeof parsed.text !== "string") return null;
    if (parsed.kind === "watchlist" && parsed.id === undefined) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveTapeSelection(selection: TapeSetSelection, storage?: TapeSetStorage | null): void {
  const store = storage ?? defaultStorage();
  if (!store) return;
  try {
    store.setItem(TAPE_SET_STORAGE_KEY, JSON.stringify(selection));
    dispatchTapeSelectionChanged(selection);
  } catch {
    // Persistence is best-effort; the tape still renders the selection.
  }
}
