/**
 * @vitest-environment jsdom
 *
 * Issue #2108 — the quote source control reads the stored setting on
 * mount and posts a change, with server-confirmed state only.
 * Issue #2689 — the control lives in SettingsMenu now, not on the
 * tape bar; this test renders the panel.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsMenu } from "../src/client/ETradeDynamicMenu";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

class FakeSocket {
  static instances: FakeSocket[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((evt: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  closed = false;
  constructor(_url: string) {
    FakeSocket.instances.push(this);
  }
  send() {}
  close() {
    this.closed = true;
    this.onclose?.();
  }
}

describe("tape source control (#2108)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;
  const origWebSocket = (globalThis as any).WebSocket;
  const origFetch = globalThis.fetch;
  const posts: unknown[] = [];

  beforeEach(() => {
    FakeSocket.instances = [];
    posts.length = 0;
    (globalThis as any).WebSocket = FakeSocket;
    globalThis.fetch = vi.fn(async (input: unknown, init?: { method?: string; body?: string }) => {
      const url = String(input);
      if (url.includes("/api/market/quotes/source")) {
        if (init?.method === "POST") {
          const body = JSON.parse(String(init.body));
          posts.push(body);
          return { ok: true, status: 200, json: async () => ({ source: body.source }) };
        }
        return { ok: true, status: 200, json: async () => ({ source: "yahoo" }) };
      }
      return { ok: true, status: 200, json: async () => ({ quotes: [] }) };
    }) as never;
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    if (root) {
      act(() => {
        root!.unmount();
      });
      root = null;
    }
    container.remove();
    (globalThis as any).WebSocket = origWebSocket;
    globalThis.fetch = origFetch;
  });

  it("shows the stored source and posts a change", async () => {
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(SettingsMenu));
    });
    // The panel body renders only once opened (hover or pin).
    const trigger = container.querySelector(".etrade-dynamic-menu-trigger") as HTMLButtonElement;
    expect(trigger).not.toBeNull();
    await act(async () => {
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const select = container.querySelector('select[aria-label="Quote source"]') as HTMLSelectElement;
    expect(select).not.toBeNull();
    expect(select.value).toBe("yahoo");
    await act(async () => {
      select.value = "alpaca";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(posts).toEqual([{ source: "alpaca" }]);
    expect(select.value).toBe("alpaca");
  });
});
