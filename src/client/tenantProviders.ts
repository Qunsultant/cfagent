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
 * response stays on the platform defaults (#3812 for the broker,
 * #3990 for the data provider: alpaca / alpaca), never on a
 * provider/broker the user did not select.
 */
import { useEffect, useState } from "react";
import { csrfHeaders } from "./apiFetch";
import { isBrokerId, type BrokerId } from "../trading";
import { brokerOptions } from "./brokerOptions";
import {
  DATA_PROVIDER_IDS,
  DATA_PROVIDER_KINDS,
  type DataProviderKind,
} from "../trading";

export { isBrokerId, type BrokerId };

export const TENANT_PROVIDERS_ENDPOINT = "/api/tenant/settings/providers";
export const TENANT_PROVIDERS_CHANGED_EVENT = "cfagent-tenant-providers-changed";
const DATA_PROVIDER_KEY = "cfagent_tenant_data_provider";
const BROKER_KEY = "cfagent_tenant_broker";

export interface TenantProvidersState {
  dataProviderId: string;
  brokerId: string;
  /**
   * Issue #3751: the served provider identity (display names from
   * the server's one identity map) for THIS state's two selections,
   * as carried on the GET providers response. Optional and additive:
   * an older id-only response still validates, and a state built
   * locally (mirror, optimistic save) simply has no served identity
   * yet — labels then come from the mirror option lists below.
   */
  dataProviderDisplayName?: string;
  brokerDisplayName?: string;
  /** True when the server's stored data-provider value fell back to the platform default. */
  dataProviderFellBack?: boolean;
  /** True when the server's stored broker value fell back to the platform default. */
  brokerFellBack?: boolean;
}

/** The identity block of the GET providers response (#3751), when present. */
interface ServedProviderIdentity {
  dataProviderDisplayName?: unknown;
  brokerDisplayName?: unknown;
  dataProviderFellBack?: unknown;
  brokerFellBack?: unknown;
}

/** Copy the well-typed identity fields out of a response's identity block. */
function identityFieldsOf(identity: ServedProviderIdentity | undefined): Partial<TenantProvidersState> {
  if (!identity) return {};
  const fields: Partial<TenantProvidersState> = {};
  if (typeof identity.dataProviderDisplayName === "string") {
    fields.dataProviderDisplayName = identity.dataProviderDisplayName;
  }
  if (typeof identity.brokerDisplayName === "string") {
    fields.brokerDisplayName = identity.brokerDisplayName;
  }
  if (typeof identity.dataProviderFellBack === "boolean") {
    fields.dataProviderFellBack = identity.dataProviderFellBack;
  }
  if (typeof identity.brokerFellBack === "boolean") {
    fields.brokerFellBack = identity.brokerFellBack;
  }
  return fields;
}

export const DEFAULT_TENANT_PROVIDERS_STATE: TenantProvidersState = {
  // Issue #3990: the data default is Alpaca (matching the broker
  // default; the reason is on the server default in
  // src/data/commercialPorts.ts). This mirror is what a fresh browser
  // shows before the server row loads; the server default is pinned
  // equal.
  dataProviderId: "alpaca",
  // Issue #3812: the platform's default broker is Alpaca in paper mode
  // (owner rule on #3451). This mirror is what a fresh browser shows
  // before the server row loads; the server default is pinned equal.
  brokerId: "alpaca",
};

/**
 * Issue #3990 — the Settings data-source list, derived from the
 * contract's kind map (one entry per provider id, in precedence
 * order) instead of a second hardcoded list. Labels are display
 * names only; the kind is what separates brokers (quote data +
 * trading) from pure data providers in the UI.
 */
const DATA_PROVIDER_LABELS: Record<string, string> = {
  etrade: "E*TRADE",
  public: "Public.com",
  yahoo: "Yahoo Finance",
  nasdaq: "Nasdaq Listings",
  alpaca: "Alpaca",
};
export const DATA_PROVIDER_OPTIONS: Array<{ id: string; label: string; kind: DataProviderKind }> =
  DATA_PROVIDER_IDS.map((id) => ({
    id,
    label: DATA_PROVIDER_LABELS[id] ?? id,
    kind: DATA_PROVIDER_KINDS[id],
  }));

/**
 * Issue #3751: the client identity projection — the label a surface
 * renders for a provider/broker id. The served identity (from the
 * server's one identity map) wins when the id IS the state's current
 * selection; otherwise the catalog-derived broker list (#3855); otherwise
 * the raw id (today's fallback — an unknown id is never dressed up
 * with a guessed brand). Names resolve at render time from ids.
 */
export function labelForDataProvider(state: TenantProvidersState, id: string): string {
  if (id === state.dataProviderId && state.dataProviderDisplayName) return state.dataProviderDisplayName;
  return DATA_PROVIDER_OPTIONS.find((o) => o.id === id)?.label ?? id;
}

/** The broker twin of labelForDataProvider. */
export function labelForBroker(state: TenantProvidersState, id: string): string {
  if (id === state.brokerId && state.brokerDisplayName) return state.brokerDisplayName;
  return brokerOptions().find((o) => o.id === id)?.label ?? id;
}

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

/** labelForBroker over the current (cached/mirrored) tenant state. */
export function currentBrokerLabel(id: string): string {
  return labelForBroker(readTenantProvidersState(), id);
}

/** labelForDataProvider over the current (cached/mirrored) tenant state. */
export function currentDataProviderLabel(id: string): string {
  return labelForDataProvider(readTenantProvidersState(), id);
}

export function loadTenantProvidersFromServer(): Promise<TenantProvidersState | null> {
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const res = await globalThis.fetch(TENANT_PROVIDERS_ENDPOINT);
      if (!res.ok) return null;
      const data = (await res.json()) as Partial<TenantProvidersState> & {
        identity?: ServedProviderIdentity;
      };
      if (typeof data.dataProviderId !== "string" || typeof data.brokerId !== "string") return null;
      const state: TenantProvidersState = {
        dataProviderId: data.dataProviderId,
        brokerId: data.brokerId,
        ...identityFieldsOf(data.identity),
      };
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
      headers: { "Content-Type": "application/json", ...csrfHeaders() },
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

export function setTenantProvidersStateForTest(partial: Partial<TenantProvidersState>): void {
  applyState({
    ...DEFAULT_TENANT_PROVIDERS_STATE,
    ...(memoryState ?? readMirrorState()),
    ...partial,
  });
}

export function resetTenantProvidersStateForTest(): void {
  memoryState = null;
  serverLoaded = false;
  loadPromise = null;
  if (typeof window !== "undefined") {
    try {
      window.localStorage.removeItem(DATA_PROVIDER_KEY);
      window.localStorage.removeItem(BROKER_KEY);
    } catch {
      // ignore
    }
  }
}
