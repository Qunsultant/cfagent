// @vitest-environment jsdom
/**
 * #6151 S1 — the client platform-context store
 * (src/client/platformContextStore.ts).
 *
 * The F2 accountBindingStore one-cache pattern, for the one shared
 * context resolution: fetched once at Chat.tsx bootstrap, every
 * surface reads through the store. The store also exposes the
 * re-fetch seam #6152 needs (fetchPlatformContext(force) +
 * invalidatePlatformContext() + usePlatformContext(),
 * emit-only-on-change).
 *
 * Rules pinned here:
 * - One network call per bootstrap: concurrent fetches share the
 *   in-flight promise; a settled load is not re-fetched without
 *   force/invalidate.
 * - A failed load never breaks the surface: it resolves to whatever
 *   was cached (null when nothing ever loaded), never throws.
 * - Emit-only-on-change: a refetch whose payload is identical to
 *   the cached one does not re-render subscribers (the snapshot
 *   keeps the same reference); a changed payload does.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  fetchPlatformContext,
  invalidatePlatformContext,
  usePlatformContext,
  type PlatformContextResponse,
} from "../src/client/platformContextStore";

function payload(overrides: Partial<PlatformContextResponse> = {}): PlatformContextResponse {
  return {
    ok: true,
    visibleTabs: { chat: true, order: true, "data-hub:data-providers": true },
    availablePresets: ["alltabs", "research"],
    personaDefault: "alltabs",
    persona: "non-paid",
    tier: "Free",
    ...overrides,
  };
}

function mockFetchOnce(body: unknown, ok = true) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status: ok ? 200 : 403 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function Probe({ onRender }: { onRender: (ctx: unknown) => void }) {
  const ctx = usePlatformContext();
  onRender(ctx);
  return null;
}

describe("platformContextStore (#6151 S1)", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    invalidatePlatformContext();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
    });
    container?.remove();
    root = null;
    container = null;
    vi.unstubAllGlobals();
  });

  it("fetches once per bootstrap: concurrent and repeat calls share one network call", async () => {
    const fetchMock = mockFetchOnce(payload());
    const [a, b] = await Promise.all([fetchPlatformContext(), fetchPlatformContext()]);
    expect(a).toEqual(payload());
    expect(b).toEqual(payload());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchPlatformContext();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("force refetches, and invalidate drops the cache so the next call refetches", async () => {
    const fetchMock = mockFetchOnce(payload());
    await fetchPlatformContext();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await fetchPlatformContext(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    invalidatePlatformContext();
    await fetchPlatformContext();
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a failed load resolves to cached (null on first load), never throws", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("network down"); }));
    await expect(fetchPlatformContext()).resolves.toBeNull();
    const fetchMock = mockFetchOnce(payload());
    await expect(fetchPlatformContext()).resolves.toEqual(payload());
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 403 })));
    await expect(fetchPlatformContext(true)).resolves.toEqual(payload());
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("emits only on change: an identical refetch does not re-render, a changed one does", async () => {
    const fetchMock = mockFetchOnce(payload());
    const renders: unknown[] = [];
    await act(async () => {
      root!.render(React.createElement(Probe, { onRender: (ctx) => { renders.push(ctx); } }));
    });
    // Mount (null) + the load landing.
    expect(renders).toHaveLength(2);
    expect(renders[1]).toEqual(payload());

    // Identical payload on a force refetch: no new render.
    await act(async () => {
      await fetchPlatformContext(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(renders).toHaveLength(2);

    // Changed payload: exactly one new render with the new values.
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify(payload({ tier: "Subscribed", persona: "paid" })), { status: 200 }),
    );
    await act(async () => {
      await fetchPlatformContext(true);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(renders).toHaveLength(3);
    expect(renders[2]).toEqual(payload({ tier: "Subscribed", persona: "paid" }));
  });

  it("the hook refetches when the cache is empty after an invalidate", async () => {
    mockFetchOnce(payload());
    const renders: unknown[] = [];
    await act(async () => {
      root!.render(React.createElement(Probe, { onRender: (ctx) => { renders.push(ctx); } }));
    });
    expect(renders).toHaveLength(2);
    await act(async () => {
      invalidatePlatformContext();
    });
    await act(async () => {});
    expect(renders.length).toBeGreaterThanOrEqual(3);
    expect(renders[renders.length - 1]).toEqual(payload());
  });
});
