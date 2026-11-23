/**
 * Client-side platform-context store (issue #6151 S1).
 *
 * The ONE client cache of the shared context resolution: fetched
 * once at Chat.tsx bootstrap (GET /api/platform/nav-availability)
 * and shared by every surface that reads tier/subscriptions/roles
 * for nav — NavigationMenu, LeftNavBar, NavSettingsPage subscribe
 * through `usePlatformContext()` instead of fetching those facts
 * themselves (enforced by tests/platform_context_client_census_6151.test.ts).
 *
 * The F2 accountBindingStore one-cache pattern: one in-memory
 * cache, one shared in-flight promise, `useSyncExternalStore`
 * subscription, emit-only-on-change (an identical payload keeps
 * the same snapshot reference, so subscribers do not re-render).
 * A failed load resolves to whatever was cached (null when nothing
 * ever loaded) — a context read must never break the surface that
 * asked for it; the surface falls back to its localStorage
 * selection (today's behavior).
 *
 * The store also exposes the re-fetch seam #6152 needs:
 * `fetchPlatformContext(force)` + `invalidatePlatformContext()` +
 * `usePlatformContext()`.
 */
import { useEffect, useSyncExternalStore } from "react";
import type { StoreTier } from "../data/commercialPorts";

export interface PlatformContextResponse {
  ok: true;
  visibleTabs: Record<string, boolean>;
  availablePresets: string[];
  personaDefault: string;
  persona: "platform-admin" | "tenant-admin" | "paid" | "non-paid";
  tier: StoreTier;
}

/** The cached context, or null when nothing has loaded yet. */
export type PlatformContext = PlatformContextResponse | null;

type Listener = () => void;

let cachedContext: PlatformContextResponse | null = null;
let loadPromise: Promise<PlatformContext> | null = null;
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

function getSnapshot(): PlatformContext {
  return cachedContext;
}

/** The cached context, or null when nothing has loaded yet. */
export function getCachedPlatformContext(): PlatformContext {
  return cachedContext;
}

function isPlatformContextResponse(value: unknown): value is PlatformContextResponse {
  return (
    !!value &&
    typeof value === "object" &&
    (value as { ok?: unknown }).ok === true &&
    typeof (value as { visibleTabs?: unknown }).visibleTabs === "object" &&
    (value as { visibleTabs?: unknown }).visibleTabs !== null &&
    Array.isArray((value as { availablePresets?: unknown }).availablePresets) &&
    typeof (value as { personaDefault?: unknown }).personaDefault === "string" &&
    typeof (value as { persona?: unknown }).persona === "string" &&
    typeof (value as { tier?: unknown }).tier === "string"
  );
}

/**
 * Load the platform context (once; the promise is shared while a
 * load is in flight). A failed load resolves to whatever was cached
 * — a context read must never break the surface that asked for it.
 */
export async function fetchPlatformContext(force = false): Promise<PlatformContext> {
  if (cachedContext && !force) return cachedContext;
  if (loadPromise) return loadPromise;
  loadPromise = fetch("/api/platform/nav-availability")
    .then(async (res) => {
      if (!res.ok) return cachedContext;
      const data: unknown = await res.json().catch(() => null);
      if (!isPlatformContextResponse(data)) return cachedContext;
      // Emit-only-on-change: an identical payload keeps the same
      // snapshot reference, so subscribers do not re-render.
      if (JSON.stringify(data) !== JSON.stringify(cachedContext)) {
        cachedContext = data;
        emit();
      }
      return cachedContext;
    })
    .catch(() => cachedContext)
    .finally(() => {
      loadPromise = null;
    });
  return loadPromise;
}

/** Drop the cache (after an invalidation, or a failed switch revert). */
export function invalidatePlatformContext(): void {
  cachedContext = null;
  loadPromise = null;
  emit();
}

/**
 * The platform context for one surface. Subscribes to the store, so
 * an invalidation or a refetch re-renders every open surface with
 * the fresh values instead of each one holding its own stale copy.
 */
export function usePlatformContext(): PlatformContext {
  const context = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Refetch whenever the cache is empty — including after an
  // invalidate (a mounted surface must not stick on "Loading…" when
  // the cache is dropped under it).
  useEffect(() => {
    if (context === null) void fetchPlatformContext();
  }, [context]);
  return context;
}
