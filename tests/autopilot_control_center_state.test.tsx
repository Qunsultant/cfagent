/** @vitest-environment jsdom */
/**
 * Issue #1704 (A3-b): no UI update presents an outcome the server has
 * not confirmed. The AutopilotControlCenter previously set its running
 * state, kill-switch state, and policy limits BEFORE the server call
 * and, on failure, left the new state in place with only a console
 * warning (plus a localStorage sync that persisted the unconfirmed
 * state). These tests pin the confirmation gate for all three actions:
 * displayed state changes only on a successful server response, and a
 * failure names the true (unchanged) state in a user-visible Notice.
 *
 * Harness follows tests/trading_approvals_queue.test.tsx:
 * react-dom/client in jsdom, direct component renders, stubbed fetch.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AutopilotControlCenter } from "../src/client/components/AutopilotControlCenter";
import { ToastProvider } from "../src/client/components/ui/Toast";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

async function flush(ms = 30) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

async function render(node: React.ReactNode, search = "?tab=autopilot&view=status") {
  // #4409: the Status card lives on its own sub-tab — the default
  // view is Performance, so these tests mount the Status tab (the
  // limits tests mount the Limits tab instead).
  window.history.pushState(null, "", `/${search}`);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ToastProvider>{node}</ToastProvider>);
  });
  await flush();
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("nextgen_autopilot_running", "false");
});

afterEach(() => {
  if (root) root.unmount();
  if (container) container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  localStorage.clear();
});

const DEFAULT_LIMITS = {
  maxPositionPct: 10.0,
  cashReservePct: 5.0,
  ordersPerDay: 10,
  drawdownAlertPct: 20.0,
  universe: "Default large caps/ETFs",
  riskProfile: "moderate",
};

type PostMode = "ok" | "fail";

function mockFetch(postMode: PostMode) {
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  const fetchMock = vi.fn(async (input: any, init?: any) => {
    const url = String(input);
    const method = init?.method || "GET";
    let body: unknown;
    try {
      body = init?.body ? JSON.parse(init.body) : undefined;
    } catch {
      body = undefined;
    }
    calls.push({ url, method, body });
    if (url === "/api/autopilot" && method === "GET") {
      return {
        ok: true,
        status: 200,
        json: async () => ({ running: false, killSwitch: false, limits: DEFAULT_LIMITS, recentVerdicts: [] }),
      } as any;
    }
    if (url.startsWith("/api/autopilot/jobs") && method === "GET") {
      return { ok: true, status: 200, json: async () => ({ jobs: [] }) } as any;
    }
    if (method === "POST" || method === "PUT") {
      if (postMode === "fail") {
        return { ok: false, status: 500, json: async () => ({ error: "upstream down" }) } as any;
      }
      return { ok: true, status: 200, json: async () => ({ limits: DEFAULT_LIMITS }) } as any;
    }
    return { ok: true, status: 200, json: async () => ({}) } as any;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls };
}

function buttonByText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === text
    ) as HTMLButtonElement | undefined ?? null
  );
}

/** The Save button's source carries a stray literal `variant="primary"` text child, so match by substring. */
function buttonContainingText(text: string): HTMLButtonElement | null {
  return (
    Array.from(document.body.querySelectorAll("button")).find((b) =>
      (b.textContent || "").includes(text)
    ) as HTMLButtonElement | undefined ?? null
  );
}

function statusText(): string {
  // The status is now a bare <span> in the Status Card (S-U2 #3051)
  // — no .status-state-text class remains. Scope to the Card headed
  // by the "Status" label, then read the span carrying exactly one
  // of the three states.
  const label = Array.from(container.querySelectorAll("span.ui-meta-sm")).find(
    (s) => s.textContent?.trim() === "Status",
  );
  const card = label?.closest(".ui-card");
  const el = card
    ? Array.from(card.querySelectorAll("span")).find((s) =>
        ["Paused", "Running", "Locked Out"].includes(s.textContent?.trim() ?? ""),
      )
    : undefined;
  return el?.textContent?.trim() || "";
}

describe("Issue #1704 — server-confirmed autopilot state", () => {
  it("mount shows the server state, not the optimistic default", async () => {
    mockFetch("ok");
    await render(<AutopilotControlCenter />);
    expect(statusText()).toBe("Paused");
  });

  it("toggle success flips the displayed state after confirmation", async () => {
    const { calls } = mockFetch("ok");
    await render(<AutopilotControlCenter />);
    await act(async () => {
      buttonByText("Resume Autopilot")!.click();
    });
    await flush();
    expect(statusText()).toBe("Running");
    const post = calls.find((c) => c.url === "/api/autopilot/state");
    expect(post).toBeDefined();
    expect(post!.body).toMatchObject({ running: true });
  });

  it("toggle failure keeps the old state and names it in a Notice", async () => {
    mockFetch("fail");
    await render(<AutopilotControlCenter />);
    await act(async () => {
      buttonByText("Resume Autopilot")!.click();
    });
    await flush();
    expect(statusText()).toBe("Paused");
    expect(container.textContent || "").toContain("could not be resumed");
    expect(container.textContent || "").toContain("still paused");
  });

  it("kill-switch failure keeps the system disarmed and says so", async () => {
    mockFetch("fail");
    await render(<AutopilotControlCenter />);
    await act(async () => {
      buttonByText("🛡️ Emergency Kill Switch")!.click();
    });
    await flush();
    await act(async () => {
      buttonByText("ACTIVATE KILL SWITCH NOW")!.click();
    });
    await flush();
    expect(statusText()).toBe("Paused");
    expect(container.textContent || "").not.toContain("Locked Out");
    expect(document.body.textContent || "").toContain("NOT locked");
    // The dialog stays open so the operator can retry.
    expect(buttonByText("ACTIVATE KILL SWITCH NOW")).not.toBeNull();
  });

  it("kill-switch success locks the system and closes the dialog", async () => {
    mockFetch("ok");
    await render(<AutopilotControlCenter />);
    await act(async () => {
      buttonByText("🛡️ Emergency Kill Switch")!.click();
    });
    await flush();
    await act(async () => {
      buttonByText("ACTIVATE KILL SWITCH NOW")!.click();
    });
    await flush();
    expect(statusText()).toBe("Locked Out");
    expect(buttonByText("ACTIVATE KILL SWITCH NOW")).toBeNull();
  });

  it("limits failure keeps the dialog open with the draft and names the old limits", async () => {
    mockFetch("fail");
    await render(<AutopilotControlCenter />, "?tab=autopilot&view=limits");
    await act(async () => {
      buttonByText("⚙️ Edit limits")!.click();
    });
    await flush();
    await act(async () => {
      buttonContainingText("Save Policy Limits")!.click();
    });
    await flush();
    expect(buttonContainingText("Save Policy Limits")).not.toBeNull();
    expect(document.body.textContent || "").toContain("previous limits still apply");
  });

  it("limits success closes the dialog", async () => {
    mockFetch("ok");
    await render(<AutopilotControlCenter />, "?tab=autopilot&view=limits");
    await act(async () => {
      buttonByText("⚙️ Edit limits")!.click();
    });
    await flush();
    await act(async () => {
      buttonContainingText("Save Policy Limits")!.click();
    });
    await flush();
    expect(buttonContainingText("Save Policy Limits")).toBeNull();
  });
});
