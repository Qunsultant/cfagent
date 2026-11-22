/**
 * Client-side account-binding store (issue #5099, F2 of #5094).
 *
 * One in-memory cache of the tenant's bindings, shared by every surface
 * that shows the active binding (BrokerDynamicMenu header, order ticket,
 * schedule dialog, portfolio / account views). A surface asks for its
 * slot with `useActiveAccountBinding({ broker, mode, accountType, scope })`
 * and gets the F1 resolution (`resolveEffectiveAccountBinding`: exact
 * scope, else the tenant default) — so a binding change re-renders every
 * open surface instead of each one holding its own stale copy.
 *
 * The cache loads lazily on first use (GET /api/broker/account-binding)
 * and is updated in place by `adoptAccountBinding` (called by the
 * AccountBindingSelector's `onSaved`) and by `switchAccountBinding`
 * (optimistic adopt, revert on failure — the `switchBrokerEnvironment`
 * pattern in BrokerDynamicMenu).
 *
 * `fetchBrokerAccounts` is the client half of the F1 validation seam:
 * GET /api/broker/accounts serves the SELECTED broker's accounts, so a
 * save/switch may include them as `availableAccounts` and the server
 * validates the tuple against the broker's real accounts
 * (`validateAccountAgainstBroker`). When the accounts read fails, is
 * gated off, or serves another broker, the caller falls back to the
 * plain upsert (the pre-F2 behavior) — validation is best-effort here,
 * never a new failure mode.
 */
import { useEffect, useSyncExternalStore } from "react";
import {
  resolveEffectiveAccountBinding,
  type AccountBinding,
  type AccountBindingScope,
  type AccountBindingTuple,
  type AccountType,
  type TradingType,
} from "../trading";

export type { AccountBindingScope, TradingType } from "../trading";
import { withCsrfInit } from "./apiFetch";

export interface ActiveBindingQuery {
  broker: string;
  mode: TradingType;
  accountType: AccountType;
  scope: AccountBindingScope;
}

export interface ActiveBindingResult {
  /** The F1 resolution found a binding (exact scope or tenant default). */
  found: boolean;
  binding: AccountBinding | null;
  /** The scope the binding was resolved from ("tenant" when falling back). */
  resolvedFromScope: AccountBindingScope | null;
  /** False until the first bindings load has landed. */
  loaded: boolean;
}

export interface BrokerAccountOption {
  accountId: string;
  accountType?: string;
  accountName?: string;
  broker: string;
}

type Listener = () => void;

let cachedBindings: AccountBinding[] | null = null;
let loadPromise: Promise<AccountBinding[]> | null = null;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): AccountBinding[] | null {
  return cachedBindings;
}

/** The cached bindings, or null when nothing has loaded yet. */
export function getCachedAccountBindings(): AccountBinding[] | null {
  return cachedBindings;
}

/**
 * Load the tenant's bindings (once; the promise is shared while a load
 * is in flight). A failed load resolves to whatever was cached (empty
 * when nothing ever loaded) — a bindings read must never break the
 * surface that asked for it.
 */
export async function fetchAccountBindings(force = false): Promise<AccountBinding[]> {
  if (cachedBindings && !force) return cachedBindings;
  if (loadPromise) return loadPromise;
  loadPromise = fetch("/api/broker/account-binding")
    .then(async (res) => {
      if (!res.ok) return cachedBindings ?? [];
      const data = (await res.json().catch(() => null)) as unknown;
      // The route answers `{ ok, bindings, registry }` — the list is
      // the wrapped field, not the bare body.
      const list =
        data && typeof data === "object" && Array.isArray((data as { bindings?: unknown }).bindings)
          ? ((data as { bindings: unknown }).bindings as AccountBinding[])
          : Array.isArray(data)
            ? (data as AccountBinding[])
            : null;
      const next = list ?? cachedBindings ?? [];
      cachedBindings = next;
      emit();
      return next;
    })
    .catch(() => cachedBindings ?? [])
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

/** Drop the cache (after a broker/mode switch, or a failed switch revert). */
export function invalidateAccountBindings(): void {
  cachedBindings = null;
  loadPromise = null;
  emit();
}

/**
 * Adopt one binding into the cache (the selector's `onSaved` path):
 * replace the stored row for the same {broker, mode, accountType, scope}
 * slot, or append it. Every subscribed surface re-renders.
 */
export function adoptAccountBinding(binding: AccountBinding): void {
  const list = cachedBindings ?? [];
  const idx = list.findIndex(
    (b) =>
      b.broker === binding.broker &&
      b.mode === binding.mode &&
      b.accountType === binding.accountType &&
      b.scope === binding.scope,
  );
  cachedBindings =
    idx >= 0
      ? [...list.slice(0, idx), binding, ...list.slice(idx + 1)]
      : [...list, binding];
  emit();
}

/**
 * The active binding for one surface's slot. Subscribes to the store, so
 * a save or switch anywhere re-renders this surface with the new tuple.
 */
export function useActiveAccountBinding(query: ActiveBindingQuery): ActiveBindingResult {
  const bindings = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Refetch whenever the cache is empty — including after an
  // invalidate (a mounted surface must not stick on "Loading…" when
  // the cache is dropped under it).
  useEffect(() => {
    if (bindings === null) void fetchAccountBindings();
  }, [bindings]);
  if (!bindings) {
    return { found: false, binding: null, resolvedFromScope: null, loaded: false };
  }
  const resolved = resolveEffectiveAccountBinding(bindings, query);
  return {
    found: resolved.found,
    binding: resolved.binding,
    resolvedFromScope: resolved.resolvedFromScope,
    loaded: true,
  };
}

/**
 * The SELECTED broker's accounts (GET /api/broker/accounts), for the
 * F1 validation seam. Returns null when the read fails, is gated off,
 * or returns no usable accounts — the caller then saves without
 * `availableAccounts` (plain upsert, the pre-F2 behavior).
 */
export async function fetchBrokerAccounts(): Promise<{ broker: string; accounts: BrokerAccountOption[] } | null> {
  try {
    const res = await fetch("/api/broker/accounts");
    if (!res.ok) return null;
    const data = (await res.json().catch(() => null)) as {
      broker?: unknown;
      result?: unknown;
    } | null;
    if (!data || !Array.isArray(data.result)) return null;
    const broker = typeof data.broker === "string" ? data.broker : "";
    const accounts = (data.result as Record<string, unknown>[])
      .filter((a) => a && typeof a.accountId === "string" && a.accountId)
      .map((a) => ({
        accountId: a.accountId as string,
        ...(typeof a.accountType === "string" ? { accountType: a.accountType } : {}),
        ...(typeof a.accountName === "string"
          ? { accountName: a.accountName }
          : typeof a.accountDesc === "string"
            ? { accountName: a.accountDesc }
            : {}),
        broker,
      }));
    return accounts.length > 0 ? { broker, accounts } : null;
  } catch {
    return null;
  }
}

export type SwitchAccountBindingResult =
  | { ok: true; binding: AccountBinding }
  | { ok: false; error: string };

/**
 * Switch the tenant binding for one {broker, mode, accountType} slot.
 * Optimistic adopt (the `switchBrokerEnvironment` pattern), then PUT
 * /api/broker/account-binding with `availableAccounts` when the caller
 * supplied the selected broker's accounts — the server validates the
 * tuple against them (`validateAccountAgainstBroker`) and refuses an
 * unknown / unowned / mismatched account with a coded error. On any
 * failure the previous cache is restored and the error returned, so no
 * surface keeps the binding the server refused.
 */
export async function switchAccountBinding(
  tuple: AccountBindingTuple,
  availableAccounts?: BrokerAccountOption[] | null,
): Promise<SwitchAccountBindingResult> {
  const previous = cachedBindings;
  const optimistic: AccountBinding = {
    broker: tuple.broker,
    mode: tuple.mode,
    accountType: tuple.accountType,
    scope: "tenant",
    accountId: tuple.accountId,
    ...(tuple.accountName ? { accountName: tuple.accountName } : {}),
    updatedAt: new Date().toISOString(),
    updatedBy: "client",
  };
  adoptAccountBinding(optimistic);
  try {
    const res = await fetch(
      "/api/broker/account-binding",
      withCsrfInit({
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          broker: tuple.broker,
          mode: tuple.mode,
          accountType: tuple.accountType,
          accountId: tuple.accountId,
          scope: "tenant",
          ...(availableAccounts ? { availableAccounts } : {}),
        }),
      }),
    );
    const data = (await res.json().catch(() => null)) as {
      error?: unknown;
      message?: unknown;
      binding?: unknown;
    } | null;
    if (!res.ok) {
      cachedBindings = previous;
      emit();
      return {
        ok: false,
        error:
          typeof data?.error === "string"
            ? data.error
            : typeof data?.message === "string"
              ? data.message
              : `Account switch failed (${res.status}).`,
      };
    }
    // The route answers `{ ok, binding, message }` — the binding is the
    // wrapped field, not the bare body.
    const saved = (data?.binding ?? null) as unknown as AccountBinding | null;
    if (saved && typeof saved.accountId === "string") adoptAccountBinding(saved);
    return { ok: true, binding: saved ?? optimistic };
  } catch (err) {
    cachedBindings = previous;
    emit();
    return { ok: false, error: err instanceof Error ? err.message : "Account switch failed." };
  }
}
