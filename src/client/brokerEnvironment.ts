/**
 * Issue #2482 — the single client-side E*TRADE environment source.
 *
 * One module value, broadcast on the existing `etrade-env-changed`
 * CustomEvent, is the only environment any component reads. The server
 * holds the durable selection (mas_settings `etrade:environment`);
 * this module mirrors it. No component reads a `localStorage`
 * environment key anymore.
 *
 * The stale keys (`cfagent_env`, `etrade_active_env`) are cleared on
 * first load, not migrated: migration would preserve the stale TEST
 * value that split the hub from the portfolio, and with two disagreeing
 * keys there is no correct one to migrate from.
 */

import { useEffect, useState } from "react";
import { apiFetch } from "./apiFetch";
import { brokerHasPaperMode, isBrokerId } from "../trading";

export type BrokerEnvironment = "TEST" | "PROD";

/**
 * Issue #3297: the value is a trading type in everything but name — TEST is
 * paper, PROD is live — and it now drives both brokers (#3280). The UI says
 * Paper/Live; the wire keeps TEST/PROD, and the stored key stays
 * `etrade:environment` because renaming it is a data migration, not a label
 * change. A future key would be `broker:environment`, read as an alias here.
 */
export const BROKER_ENVIRONMENT_STORAGE_KEY = "etrade:environment";

export const BROKER_ENV_CHANGED_EVENT = "etrade-env-changed";

const STALE_BROKER_ENV_KEYS = ["cfagent_env", "etrade_active_env"] as const;

export function isBrokerEnvironment(value: unknown): value is BrokerEnvironment {
  return value === "TEST" || value === "PROD";
}

/**
 * Issue #4587 — the top-left crumb shows broker + mode, never mode
 * alone: "<broker> / Paper", "<broker> / Live Execution". The live
 * word stays "Live Execution", the wording the crumb already used.
 *
 * Issue #4649 (matrix gap 1): the mode word is the broker's capability,
 * not the stored environment's name. A broker with no paper account (a
 * live-only broker) never renders "Paper": in TEST it reads "Live
 * Execution", because live is the only mode in which an order could ever
 * place, and the dialog + Notice disclose that. Display-only was rejected —
 * the selection auto-switches the stored mode to PROD, so the crumb and the
 * stored mode agree.
 */
export function brokerModeLabel(params: {
  /** The broker id, so the mode word can read its capability. */
  broker: unknown;
  /** The label the caller resolved for the broker (served identity or catalog). */
  brokerLabel: string;
  accountMode: "paper" | "live";
}): string {
  const rendersPaper = params.accountMode === "paper" && brokerCanSimulate(params.broker);
  return `${params.brokerLabel} / ${rendersPaper ? "Paper" : "Live Execution"}`;
}

/**
 * Issue #4649: true when the broker has a simulated (paper) account, so the
 * word "Paper" is truthful for it. An unrecognised id answers true — an
 * unknown broker must never be claimed to be live-only.
 */
export function brokerCanSimulate(broker: unknown): boolean {
  return isBrokerId(broker) ? brokerHasPaperMode(broker) : true;
}

/** Remove the pre-#2482 keys. Never read as authority again. */
export function clearStaleBrokerEnvironmentKeys(): void {
  if (typeof window === "undefined") return;
  for (const key of STALE_BROKER_ENV_KEYS) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // Storage unavailable — nothing to clear, and the server value
      // below remains the authority.
    }
  }
}

clearStaleBrokerEnvironmentKeys();

let current: BrokerEnvironment = "TEST";

const listeners = new Set<() => void>();

function setCurrent(env: BrokerEnvironment, broadcast: boolean): void {
  if (env === current) return;
  current = env;
  for (const listener of [...listeners]) listener();
  if (broadcast && typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(BROKER_ENV_CHANGED_EVENT, { detail: { env } }),
    );
  }
}

/** The current single value. Components should use the hook instead. */
export function getBrokerEnvironment(): BrokerEnvironment {
  return current;
}

function subscribeBrokerEnvironment(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Load the server-persisted selection at boot and adopt it. On any
 * failure the current value stands — the server default is TEST
 * (paper, issue #3857), so a failed load never shows a stale PROD.
 */
export async function fetchBrokerEnvironment(): Promise<BrokerEnvironment> {
  try {
    const resp = await apiFetch("/api/broker/etrade/environment");
    if (!resp.ok) return current;
    const data = (await resp.json().catch(() => ({}))) as {
      environment?: unknown;
    };
    if (isBrokerEnvironment(data.environment)) setCurrent(data.environment, true);
    return current;
  } catch {
    return current;
  }
}

/**
 * Toggle through to the server source of truth: POST persists the
 * selection, then adopt the echoed value. On failure the current value
 * stands and no local key is written anywhere.
 */
export async function switchBrokerEnvironment(
  target: BrokerEnvironment,
): Promise<BrokerEnvironment> {
  const previous = current;
  // Optimistically adopt target environment across UI subscribers
  setCurrent(target, true);
  try {
    const resp = await apiFetch("/api/environment/switch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ environment: target }),
    });
    if (!resp.ok) {
      setCurrent(previous, true);
      return current;
    }
    const data = (await resp.json().catch(() => ({}))) as {
      environment?: unknown;
    };
    if (isBrokerEnvironment(data.environment)) {
      setCurrent(data.environment, true);
    } else {
      setCurrent(target, true);
    }
    return current;
  } catch {
    setCurrent(previous, true);
    return current;
  }
}

/**
 * Subscribe to the single environment value. Also honors
 * `etrade-env-changed` events from any path so a broadcast always
 * converges every subscriber on the same value.
 */
export function useBrokerEnvironment(): BrokerEnvironment {
  const [env, setEnv] = useState<BrokerEnvironment>(current);
  useEffect(() => {
    const sync = () => setEnv(getBrokerEnvironment());
    const onEvent = (e: Event) => {
      const next = (e as CustomEvent).detail?.env;
      if (isBrokerEnvironment(next)) setCurrent(next, false);
      sync();
    };
    const unsubscribe = subscribeBrokerEnvironment(sync);
    window.addEventListener(BROKER_ENV_CHANGED_EVENT, onEvent);
    sync();
    return () => {
      unsubscribe();
      window.removeEventListener(BROKER_ENV_CHANGED_EVENT, onEvent);
    };
  }, []);
  return env;
}

/**
 * Test-only: set the single environment value directly (issue #5879).
 * Follows setTenantProvidersStateForTest: tests drive the module value
 * instead of passing a prop, because the menu reads this value and no
 * other source. Broadcasts so mounted subscribers converge; a render
 * after the call reads the new value from the hook's initial state.
 * Tests that flip the value must reset it to TEST afterwards — the
 * module is process-global and leaks across tests in a file.
 */
export function setBrokerEnvironmentForTest(env: BrokerEnvironment): void {
  setCurrent(env, true);
}
