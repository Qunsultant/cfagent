/**
 * Issue #2481 — the single global auto-refresh switch.
 *
 * Owner decision 2026-10-30: the switch is a PER-TENANT SETTING
 * whose source of truth is the tenant store, edited via the
 * dynamic panel. The panel is the editor, not the truth, and no
 * surface keeps its own local copy. Concretely:
 *
 * - Source of truth: the tenant row in D1 agent_tenant_settings
 *   (migration 0026), served by GET/POST
 *   /api/tenant/settings/auto-refresh (handler in
 *   src/agents/routes/reports.ts, reached through the Worker's
 *   generic /api/ forwarder). The tenant is server-resolved
 *   (resolveIaaaTenant); the client never supplies it.
 * - Execution context: the app shell loads the tenant setting
 *   at boot (loadAutoRefreshFromServer) into this module's
 *   in-memory state, and every periodic refresh run reads this
 *   module — directly (isAutoRefreshEnabled), or through
 *   useAutoRefresh / usePolling's enabled flag. The setting is
 *   NOT stored only in execution context: the in-memory state
 *   is a cache of the server row, refreshed from the server on
 *   boot, on toggle, and on cross-tab storage events.
 * - Toggle path: saveAutoRefresh POSTs to the server first in
 *   effect (optimistic cache update, revert on failure, so the
 *   UI never shows a value the server did not accept).
 * - Fallback mirror: browser localStorage (the single global
 *   key family cfagent_global_autorefresh_*, with the legacy
 *   options/research keys migrated into it once) holds only
 *   the last-known server value. It is used before the boot
 *   load completes, when the server is unreachable, and by the
 *   pre-authentication landing page, which cannot call the
 *   authenticated route. A fresh browser with no mirror and
 *   no server response stays OFF (fail-closed for periodic
 *   refresh) until the server load succeeds.
 *
 * Before this module, the toggle existed in two places (Chat
 * and ETradeDynamicMenu), each with its own state and three
 * localStorage key families, and only Chat's global timer
 * checked the switch at all. Every periodic live-data refresh
 * now reads this module and nothing else.
 *
 * OFF means no periodic refresh at all. Manual refresh and
 * initial loads are not periodic and are unaffected.
 *
 * Default OFF: that is the default the pre-existing Chat/menu
 * code already used when no value was stored, and the default
 * for an absent tenant row. No owner-approved default was
 * found in the repo; this module preserves the existing
 * default and says so, rather than inventing a policy.
 *
 * Window/localStorage/fetch access is guarded so importing
 * this module on the server (or in a test without a window)
 * returns the default instead of throwing.
 */

import { useEffect, useState } from "react";
import { POLLING_CONFIG_DEFAULTS } from "./pollingConfig";
import { csrfHeaders } from "./apiFetch";

export const AUTO_REFRESH_ENABLED_KEY = "cfagent_global_autorefresh_enabled";
export const AUTO_REFRESH_INTERVAL_KEY = "cfagent_global_autorefresh_interval";
export const AUTO_REFRESH_CHANGED_EVENT = "cfagent-autorefresh-changed";
export const AUTO_REFRESH_ENDPOINT = "/api/tenant/settings/auto-refresh";

/** Legacy key families, read once for migration and then unused. */
const LEGACY_ENABLED_KEYS = [
  "cfagent_options_autorefresh_enabled",
  "cfagent_options_research_autorefresh_enabled",
];
const LEGACY_INTERVAL_KEYS = [
  "cfagent_options_autorefresh_interval",
  "cfagent_options_research_autorefresh_interval",
];

/** Issue #2513 — the default interval now comes from the polling config (15s), not a standalone magic constant. The tenant row, once loaded, still wins over this default. */
export const AUTO_REFRESH_DEFAULT_INTERVAL_S = POLLING_CONFIG_DEFAULTS.autoRefreshDefaultS;

export interface AutoRefreshState {
  enabled: boolean;
  /** Cadence in seconds; the Chat timer floors it at CHAT_AUTO_REFRESH_FLOOR_S. */
  interval: number;
}

export const AUTO_REFRESH_DEFAULT_STATE: AutoRefreshState = {
  enabled: false,
  interval: AUTO_REFRESH_DEFAULT_INTERVAL_S,
};

/** In-memory execution-context cache of the tenant setting. */
let memoryState: AutoRefreshState | null = null;
let serverLoaded = false;
let loadPromise: Promise<AutoRefreshState | null> | null = null;

function readStored(key: string): string | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, SSR): state stays in
    // memory for this tab; the toggle still works for the session.
  }
}

/**
 * The fallback mirror: last-known server value (or a migrated
 * legacy value). This is never the source of truth once the
 * server load has succeeded — readAutoRefreshState prefers the
 * in-memory server cache over it.
 */
function readMirrorState(): AutoRefreshState {
  const globalEnabled = readStored(AUTO_REFRESH_ENABLED_KEY);
  const globalInterval = readStored(AUTO_REFRESH_INTERVAL_KEY);
  if (globalEnabled !== null || globalInterval !== null) {
    const interval = globalInterval !== null ? Number(globalInterval) : NaN;
    return {
      enabled: globalEnabled === "true",
      interval: Number.isFinite(interval) && interval > 0 ? interval : AUTO_REFRESH_DEFAULT_INTERVAL_S,
    };
  }
  for (const key of LEGACY_ENABLED_KEYS) {
    const legacy = readStored(key);
    if (legacy !== null) {
      const intervalRaw = LEGACY_INTERVAL_KEYS.map((k) => readStored(k)).find((v) => v !== null);
      const interval = intervalRaw !== undefined ? Number(intervalRaw) : NaN;
      const migrated: AutoRefreshState = {
        enabled: legacy === "true",
        interval: Number.isFinite(interval) && interval > 0 ? interval : AUTO_REFRESH_DEFAULT_INTERVAL_S,
      };
      writeStored(AUTO_REFRESH_ENABLED_KEY, String(migrated.enabled));
      writeStored(AUTO_REFRESH_INTERVAL_KEY, String(migrated.interval));
      return migrated;
    }
  }
  return { ...AUTO_REFRESH_DEFAULT_STATE };
}

/** Current switch state: server cache when loaded, else the mirror. */
export function readAutoRefreshState(): AutoRefreshState {
  return memoryState ?? readMirrorState();
}

export function isAutoRefreshEnabled(): boolean {
  return readAutoRefreshState().enabled;
}

export function getAutoRefreshInterval(): number {
  return readAutoRefreshState().interval;
}

/** True once a server load has populated the execution-context cache. */
export function hasServerAutoRefreshLoaded(): boolean {
  return serverLoaded;
}

/**
 * Test-only seam: clears the execution-context cache so a test
 * starts from the mirror/default instead of a previous test's
 * server value. Production code never calls this.
 */
export function resetAutoRefreshCacheForTests(): void {
  memoryState = null;
  serverLoaded = false;
  loadPromise = null;
}

function dispatchChange(state: AutoRefreshState): void {
  try {
    if (typeof window === "undefined") return;
    window.dispatchEvent(
      new CustomEvent(AUTO_REFRESH_CHANGED_EVENT, { detail: { ...state } }),
    );
  } catch {
    // Dispatch failure must never break the toggle itself.
  }
}

/**
 * Apply a state to the execution-context cache and the fallback
 * mirror, and notify subscribers. This is the only cache writer;
 * the server write itself goes through saveAutoRefresh.
 */
export function applyAutoRefreshState(state: AutoRefreshState): AutoRefreshState {
  const next = { ...state };
  memoryState = next;
  writeStored(AUTO_REFRESH_ENABLED_KEY, String(next.enabled));
  writeStored(AUTO_REFRESH_INTERVAL_KEY, String(next.interval));
  dispatchChange(next);
  return next;
}

/**
 * Load the tenant setting from the server into execution
 * context. Concurrent callers share one in-flight request.
 * Returns null (leaving the mirror in place) when the server
 * is unreachable or the response is not a valid setting.
 */
export function loadAutoRefreshFromServer(): Promise<AutoRefreshState | null> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
      if (typeof fetchFn !== "function") return null;
      const res = await fetchFn(AUTO_REFRESH_ENDPOINT, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) return null;
      const data = (await res.json().catch(() => null)) as {
        enabled?: unknown;
        intervalS?: unknown;
      } | null;
      if (!data || typeof data.enabled !== "boolean") return null;
      const interval =
        typeof data.intervalS === "number" && data.intervalS > 0
          ? data.intervalS
          : readAutoRefreshState().interval;
      serverLoaded = true;
      return applyAutoRefreshState({ enabled: data.enabled, interval });
    } catch {
      return null;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

/**
 * The single toggle path (dynamic panel editor). Optimistically
 * applies the new value, POSTs it to the tenant store, and
 * reverts to the previous value if the server rejects it, so
 * the UI never shows a value the server did not accept. The
 * server's response, when valid, wins over the optimistic value.
 */
export async function saveAutoRefresh(enabled: boolean, interval?: number): Promise<boolean> {
  const previous = readAutoRefreshState();
  const optimistic: AutoRefreshState = {
    enabled,
    interval:
      interval !== undefined && Number.isFinite(interval) && interval > 0
        ? interval
        : previous.interval,
  };
  applyAutoRefreshState(optimistic);
  try {
    const fetchFn = (globalThis as { fetch?: typeof fetch }).fetch;
    if (typeof fetchFn !== "function") {
      applyAutoRefreshState(previous);
      return false;
    }
    const res = await fetchFn(AUTO_REFRESH_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", ...csrfHeaders() },
      body: JSON.stringify({ enabled, intervalS: optimistic.interval }),
    });
    if (!res.ok) {
      applyAutoRefreshState(previous);
      return false;
    }
    const data = (await res.json().catch(() => null)) as {
      enabled?: unknown;
      intervalS?: unknown;
    } | null;
    if (data && typeof data.enabled === "boolean") {
      const serverInterval =
        typeof data.intervalS === "number" && data.intervalS > 0
          ? data.intervalS
          : optimistic.interval;
      serverLoaded = true;
      applyAutoRefreshState({ enabled: data.enabled, interval: serverInterval });
    } else {
      serverLoaded = true;
    }
    return true;
  } catch {
    applyAutoRefreshState(previous);
    return false;
  }
}

/**
 * Backwards-compatible cache setter, kept for tests and for
 * surfaces that apply a server-loaded value. Production toggles
 * must use saveAutoRefresh so the server row is the truth.
 */
export function setAutoRefresh(enabled: boolean, interval?: number): AutoRefreshState {
  const current = readAutoRefreshState();
  return applyAutoRefreshState({
    enabled,
    interval:
      interval !== undefined && Number.isFinite(interval) && interval > 0
        ? interval
        : current.interval,
  });
}

/** Subscribe to switch changes (toggle, server load, or another tab). */
export function subscribeAutoRefresh(listener: (state: AutoRefreshState) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const onCustom = (event: Event) => {
    const detail = (event as CustomEvent).detail as Partial<AutoRefreshState> | undefined;
    if (detail && typeof detail.enabled === "boolean") {
      listener({
        enabled: detail.enabled,
        interval:
          typeof detail.interval === "number" && detail.interval > 0
            ? detail.interval
            : readAutoRefreshState().interval,
      });
    } else {
      listener(readAutoRefreshState());
    }
  };
  const onStorage = (event: StorageEvent) => {
    if (
      event.key !== null &&
      event.key !== AUTO_REFRESH_ENABLED_KEY &&
      event.key !== AUTO_REFRESH_INTERVAL_KEY
    ) {
      return;
    }
    // Another tab changed the mirror: re-read the server truth
    // rather than trusting the mirror (it may be stale).
    if (serverLoaded) {
      void loadAutoRefreshFromServer().then((state) => {
        if (state) listener(state);
      });
    } else {
      listener(readAutoRefreshState());
    }
  };
  window.addEventListener(AUTO_REFRESH_CHANGED_EVENT, onCustom);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(AUTO_REFRESH_CHANGED_EVENT, onCustom);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * React binding: current state plus the server-backed setter.
 * Mounting also triggers the boot load of the tenant setting
 * into execution context (deduplicated across instances).
 */
export function useAutoRefresh(): [AutoRefreshState, (enabled: boolean, interval?: number) => void] {
  const [state, setState] = useState<AutoRefreshState>(() => readAutoRefreshState());
  useEffect(() => {
    const unsub = subscribeAutoRefresh(setState);
    void loadAutoRefreshFromServer();
    return unsub;
  }, []);
  return [state, (enabled: boolean, interval?: number) => {
    void saveAutoRefresh(enabled, interval);
  }];
}
