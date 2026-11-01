/**
 * Per-tenant data-provider / broker selection (slice 1 of the
 * provider/broker agnosticism programme).
 *
 * Mirrors src/client/autoRefresh.ts: the server row in D1
 * agent_tenant_settings (migration 0027) is the source of truth,
 * served by GET/POST /api/tenant/settings/providers; the tenant
 * is server-resolved, the client never supplies it. In-memory
 * state is a cache of the server value; localStorage holds only
 * the last-known server value as a mirror, used before the boot
 * load completes. A fresh browser with no mirror and no server
 * response stays etrade / etrade (fail to the legacy behaviour),
 * never to a provider/broker the user did not select.
 */
import { useEffect, useState } from "react";

export const TENANT_PROVIDERS_ENDPOINT = "/api/tenant/settings/providers";
export const TENANT_PROVIDERS_CHANGED_EVENT = "cfagent-tenant-providers-changed";
const DATA_PROVIDER_KEY = "cfagent_tenant_data_provider";
const BROKER_KEY = "cfagent_tenant_broker";

export interface TenantProvidersState {
  dataProviderId: string;
  brokerId: string;
}

export const DEFAULT_TENANT_PROVIDERS_STATE: TenantProvidersState = {
  dataProviderId: "etrade",
  brokerId: "etrade",
};

export const DATA_PROVIDER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "etrade", label: "E*TRADE" },
  { id: "public", label: "Public.com" },
  { id: "yahoo", label: "Yahoo Finance" },
  { id: "nasdaq", label: "Nasdaq Listings" },
  { id: "alpaca", label: "Alpaca" },
];

export const BROKER_OPTIONS: Array<{ id: string; label: string }> = [
  { id: "etrade", label: "E*TRADE" },
  { id: "alpaca", label: "Alpaca" },
];

let memoryState: TenantProvidersState | null = null;
let serverLoaded = false;
let loadPromise: Promise<TenantProvidersState | null> | null = null;

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
    // ignore
  }
}

function readMirrorState(): TenantProvidersState {
  return {
    dataProviderId: readStored(DATA_PROVIDER_KEY) ?? DEFAULT_TENANT_PROVIDERS_STATE.dataProviderId,
    brokerId: readStored(BROKER_KEY) ?? DEFAULT_TENANT_PROVIDERS_STATE.brokerId,
  };
}

function applyState(state: TenantProvidersState): void {
  memoryState = state;
  writeStored(DATA_PROVIDER_KEY, state.dataProviderId);
  writeStored(BROKER_KEY, state.brokerId);
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(TENANT_PROVIDERS_CHANGED_EVENT, { detail: state }));
  }
}

export function readTenantProvidersState(): TenantProvidersState {
  if (memoryState) return memoryState;
  if (serverLoaded) return readMirrorState();
  return readMirrorState();
}

export function loadTenantProvidersFromServer(): Promise<TenantProvidersState | null> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const res = await globalThis.fetch(TENANT_PROVIDERS_ENDPOINT);
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<TenantProvidersState>;
      if (typeof data.dataProviderId !== "string" || typeof data.brokerId !== "string") return null;
      const state = { dataProviderId: data.dataProviderId, brokerId: data.brokerId };
      serverLoaded = true;
      applyState(state);
      return state;
    } catch {
      return null;
    } finally {
      loadPromise = null;
    }
  })();
  return loadPromise;
}

export async function saveTenantProviders(
  state: TenantProvidersState,
): Promise<TenantProvidersState> {
  const previous = readTenantProvidersState();
  applyState(state);
  try {
    const res = await globalThis.fetch(TENANT_PROVIDERS_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(state),
    });
    if (!res.ok) throw new Error("Failed to save provider selection");
    const data = (await res.json()) as Partial<TenantProvidersState>;
    if (typeof data.dataProviderId === "string" && typeof data.brokerId === "string") {
      const saved = { dataProviderId: data.dataProviderId, brokerId: data.brokerId };
      serverLoaded = true;
      applyState(saved);
      return saved;
    }
    return state;
  } catch (err) {
    applyState(previous);
    throw err;
  }
}

export function useTenantProviders(): [
  TenantProvidersState,
  (state: TenantProvidersState) => Promise<TenantProvidersState>,
] {
  const [state, setState] = useState<TenantProvidersState>(() => readTenantProvidersState());
  useEffect(() => {
    let cancelled = false;
    void loadTenantProvidersFromServer().then((loaded) => {
      if (!cancelled && loaded) setState(loaded);
    });
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as TenantProvidersState | undefined;
      if (detail) setState(detail);
    };
    window.addEventListener(TENANT_PROVIDERS_CHANGED_EVENT, handler);
    return () => {
      cancelled = true;
      window.removeEventListener(TENANT_PROVIDERS_CHANGED_EVENT, handler);
    };
  }, []);
  return [state, saveTenantProviders];
}

/** Coded broker-unavailable notice text for a hidden broker surface.
 * For alpaca it names the honest fallback: the direct Alpaca API
 * paths remain addressable; there is no Alpaca panel yet (slice 3). */
export function brokerUnavailableNotice(brokerId: string, brokerLabel: string): string {
  const base = `This broker surface is not available for the selected broker (${brokerLabel}). Change the broker selection in Settings.`;
  return brokerId === "alpaca"
    ? `${base} Alpaca account, positions and orders remain available via the direct Alpaca API paths.`
    : base;
}
