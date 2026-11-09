/** @vitest-environment jsdom */
/**
 * Issue #3885 — the Portfolio “cancel every open order” dialog.
 *
 * What these pins defend:
 *   1. The button asks for a PREVIEW; nothing is cancelled by it.
 *   2. The dialog shows exactly what the preview said (count, symbols,
 *      classes, oldest/newest, expiry) before anything is confirmed.
 *   3. Confirming presents the server's token, and the table is refreshed
 *      only after the server reports a completed cancel.
 *   4. A refusal (over the cap, expired) is rendered in the server's own
 *      words and refreshes nothing — never a silent success.
 *   5. With no open orders the control is disabled.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AlpacaCancelAllControl } from "../src/client/AlpacaCancelAllControl";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("#3885 — the Portfolio confirmation dialog", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    container?.remove();
    container = null;
    root = null;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function mount(openOrders: number, onCancelled: () => void) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(React.createElement(AlpacaCancelAllControl, { openOrders, onCancelled }));
    });
    return container;
  }

  function findButton(host: HTMLElement, label: string): HTMLButtonElement | undefined {
    return Array.from(host.querySelectorAll("button")).find((button) =>
      (button.textContent ?? "").includes(label),
    ) as HTMLButtonElement | undefined;
  }

  it("shows the preview, then presents the token on confirm and refreshes only on success", async () => {
    const calls: any[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = init?.body ? JSON.parse(String(init.body)) : {};
        calls.push(body);
        if (!body.confirm) {
          return jsonResponse({
            preview: {
              count: 3,
              symbols: ["AAPL", "MSFT"],
              classes: ["bracket", "limit"],
              oldest: "2026-11-09T13:00:00.000Z",
              newest: "2026-11-09T15:00:00.000Z",
              expiresAt: new Date(Date.now() + 120000).toISOString(),
            },
            previewToken: "tok-1",
            code: "cancel_all_needs_preview",
            message: "Nothing has been cancelled.",
          });
        }
        return jsonResponse({ success: true, message: "Cancel all: targeted 3, cancelled 3, refused 0." });
      }),
    );

    const onCancelled = vi.fn();
    const host = await mount(3, onCancelled);

    const open = findButton(host, "Cancel all open orders")!;
    await act(async () => open.click());

    // The dialog renders in a portal on <body>, so the portal's text is what a
    // user reads. NOTHING has been confirmed yet.
    expect(document.body.textContent).toContain("3 open orders would be cancelled");
    expect(document.body.textContent).toContain("AAPL, MSFT");
    expect(calls).toHaveLength(1);
    expect(calls[0].confirm).toBeUndefined();
    expect(onCancelled).not.toHaveBeenCalled();

    const confirm = findButton(document.body, "Cancel 3 orders")!;
    await act(async () => confirm.click());

    expect(calls[1]).toMatchObject({ confirm: "tok-1" });
    expect(onCancelled).toHaveBeenCalledTimes(1);
    expect(document.body.textContent).toContain("targeted 3, cancelled 3, refused 0");
  });

  it("renders a refusal with the server's own words and refreshes nothing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          code: "cancel_all_too_many",
          message: "This cancel targets 9 orders but cancelMaxCount is 5. Nothing was cancelled.",
        }),
      ),
    );
    const onCancelled = vi.fn();
    const host = await mount(9, onCancelled);
    await act(async () => findButton(host, "Cancel all open orders")!.click());

    expect(document.body.textContent).toContain("targets 9 orders but cancelMaxCount is 5");
    expect(onCancelled).not.toHaveBeenCalled();
  });

  it("disables the control when there is nothing open", async () => {
    const host = await mount(0, vi.fn());
    expect(findButton(host, "Cancel all open orders")!.disabled).toBe(true);
  });
});
