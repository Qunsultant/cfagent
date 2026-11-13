/**
 * Issue #1922 — ScheduledGoalsPanel add-goal gaps: timeZone field,
 * catalog operation dropdown, SessionStore resource-goals preset.
 *
 * Red first: the panel has no timeZone input, a free-text operation
 * input, and no preset action.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ScheduledGoalsPanel } from "../src/client/ScheduledGoalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPERATIONS = [
  { operation: "search.query", agent: "search", blurb: "Web and data search." },
  { operation: "resource.rollup_daily", agent: "resource", blurb: "SessionStore resource rollup." },
  { operation: "resource.cap_alert", agent: "resource", blurb: "SessionStore cap alert." },
  { operation: "resource.dashboard_comparison", agent: "resource", blurb: "SessionStore dashboard comparison." },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let posted: { path: string; body: any }[];
let failIds: Set<string>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  posted = [];
  failIds = new Set();
  (globalThis as any).fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/schedule/goals" && method === "GET") {
      return jsonResponse({ ok: true, goals: [] });
    }
    if (path.startsWith("/api/schedule/ticks")) {
      return jsonResponse({ ok: true, ticks: [] });
    }
    if (path === "/api/schedule/operations" && method === "GET") {
      return jsonResponse({ ok: true, operations: OPERATIONS });
    }
    if (path === "/api/schedule/goals" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      posted.push({ path, body });
      if (failIds.has(body.id)) {
        return jsonResponse({ ok: false, error: `Goal already exists: ${body.id}` }, 400);
      }
      return jsonResponse({ ok: true, goal: body });
    }
    return jsonResponse({ ok: false, error: "not found" }, 404);
  });
}

async function renderPanel() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(<ScheduledGoalsPanel />);
  });
  await act(async () => {});
}

function inputByPlaceholder(text: string): HTMLInputElement {
  // Match on the attribute value directly: the cron placeholder
  // contains nested double quotes, which break a CSS attribute selector.
  const el = Array.from(container.querySelectorAll("input")).find(
    (i) => i.getAttribute("placeholder") === text,
  ) as HTMLInputElement | undefined;
  if (!el) throw new Error(`input with placeholder ${text} not found`);
  return el;
}

function setInput(el: HTMLInputElement | HTMLSelectElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(
    (el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement).prototype,
    "value",
  )?.set;
  setter?.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

// Issue #4333: the panel is sub-tabbed, so a tab and a control can share
// a label ("Add goal"). "A button by text" means a control, never a tab.
function buttonByText(text: string): HTMLButtonElement {
  const el = Array.from(container.querySelectorAll("button")).find(
    (b) => b.getAttribute("role") !== "tab" && b.textContent === text,
  );
  if (!el) throw new Error(`button ${text} not found`);
  return el as HTMLButtonElement;
}

beforeEach(() => {
  installFetch();
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
  });
  container.remove();
  vi.restoreAllMocks();
});

describe("ScheduledGoalsPanel add-goal gaps (#1922)", () => {
  it("shows a timeZone input prefilled UTC and an operation dropdown from the catalog", async () => {
    await renderPanel();
    const tz = inputByPlaceholder("timeZone (IANA, e.g. UTC)");
    expect(tz.value).toBe("UTC");
    const select = container.querySelector('select[aria-label="operation"]') as HTMLSelectElement | null;
    expect(select).not.toBeNull();
    const options = Array.from(select!.options).map((o) => o.value);
    expect(options).toContain("resource.rollup_daily");
    expect(options).toContain("resource.cap_alert");
    expect(options).toContain("resource.dashboard_comparison");
    expect(container.querySelector('input[placeholder="operation (e.g. search.query)"]')).toBeNull();
  });

  it("rejects an invalid timeZone without posting", async () => {
    await renderPanel();
    setInput(inputByPlaceholder("id (e.g. weekly-report)"), "g1");
    setInput(inputByPlaceholder("name"), "G1");
    setInput(inputByPlaceholder('cron (e.g. "0 6 * * *")'), "0 6 * * *");
    setInput(inputByPlaceholder("timeZone (IANA, e.g. UTC)"), "Not/AZone");
    setInput(inputByPlaceholder("budget in cents (e.g. 500)"), "1");
    const select = container.querySelector('select[aria-label="operation"]') as HTMLSelectElement;
    setInput(select, "resource.rollup_daily");
    await act(async () => {
      buttonByText("Add goal").click();
    });
    expect(container.textContent).toMatch(/Invalid timeZone/);
    expect(posted).toHaveLength(0);
  });

  it("preset adds missing goals and skips existing ones with per-goal results", async () => {
    failIds = new Set(["resource-cap-alert"]);
    await renderPanel();
    await act(async () => {
      buttonByText("Add SessionStore resource goals").click();
    });
    await act(async () => {});
    expect(posted.map((p) => p.body.id).sort()).toEqual([
      "resource-cap-alert",
      "resource-daily-rollup",
      "resource-dashboard-comparison",
    ]);
    expect(posted.every((p) => p.body.timeZone === "UTC")).toBe(true);
    expect(posted.every((p) => p.body.budgetCents === 1)).toBe(true);
    expect(container.textContent).toMatch(/resource-daily-rollup.*Added/);
    expect(container.textContent).toMatch(/resource-cap-alert.*already exists/i);
    expect(container.textContent).toMatch(/resource-dashboard-comparison.*Added/);
  });

  it("surfaces a 401 from the goals list instead of failing silently", async () => {
    (globalThis as any).fetch = vi.fn(async (path: string) => {
      if (path === "/api/schedule/goals") {
        return jsonResponse({ ok: false, error: "Unauthorized: Please log in." }, 401);
      }
      if (path.startsWith("/api/schedule/ticks")) return jsonResponse({ ok: true, ticks: [] });
      if (path === "/api/schedule/operations") return jsonResponse({ ok: true, operations: OPERATIONS });
      return jsonResponse({ ok: false, error: "not found" }, 404);
    });
    await renderPanel();
    expect(container.textContent).toMatch(/Unauthorized: Please log in\./);
  });
});
