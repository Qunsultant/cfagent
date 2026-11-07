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

let current: BrokerEnvironment = "PROD";

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
 * failure the current value stands — the server default is PROD, so a
 * failed load never shows a stale TEST.
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
