/**
 * Issue #3996 — ScheduledGoalsPanel built-in goal dropdown +
 * seed-all button.
 *
 * Red first: the panel has no built-in dropdown, no seed-all
 * button, and no enabled toggle on the Add-goal form.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { ScheduledGoalsPanel } from "../src/client/ScheduledGoalsPanel";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const OPERATIONS = [
  { operation: "qa.run_sweep", agent: "qa", blurb: "Daily QA sweep." },
  { operation: "search.opportunity_hunt", agent: "search", blurb: "Opportunity hunt." },
  { operation: "social.publish", agent: "social", blurb: "Daily social post." },
  { operation: "resource.rollup_daily", agent: "resource", blurb: "SessionStore resource rollup." },
  { operation: "resource.cap_alert", agent: "resource", blurb: "SessionStore cap alert." },
  { operation: "resource.dashboard_comparison", agent: "resource", blurb: "SessionStore dashboard comparison." },
  { operation: "index.refresh_wikipedia", agent: "index", blurb: "Index-list refresh (Wikipedia)." },
  { operation: "index.refresh_holdings", agent: "index", blurb: "Index-list refresh (ETF holdings)." },
];

// Canonical built-ins (the server's DEFAULT_SCHEDULES, as the
// fixture the mocked endpoint returns) — the test asserts the
// panel renders and uses exactly these, in this order.
const BUILTINS = [
  { id: "daily-qa-sweep", name: "Daily QA sweep", cron: "0 6 * * *", operation: "qa.run_sweep", budgetCents: 500, enabled: true },
  { id: "opportunity-hunt", name: "Opportunity hunt", cron: "0 */6 * * *", operation: "search.opportunity_hunt", budgetCents: 1000, enabled: true },
  { id: "daily-social-post", name: "Daily social post", cron: "0 9 * * 1-5", operation: "social.publish", budgetCents: 1, enabled: false, timeZone: "America/New_York" },
  { id: "resource-daily-rollup", name: "SessionStore daily resource rollup", cron: "30 1 * * *", operation: "resource.rollup_daily", budgetCents: 1, enabled: true, timeZone: "UTC" },
  { id: "resource-cap-alert", name: "SessionStore 70% cap alert", cron: "0 * * * *", operation: "resource.cap_alert", budgetCents: 1, enabled: true, timeZone: "UTC" },
  { id: "resource-dashboard-comparison", name: "SessionStore dashboard comparison", cron: "0 2 * * *", operation: "resource.dashboard_comparison", budgetCents: 1, enabled: true, timeZone: "UTC" },
  { id: "index-refresh-wikipedia", name: "Index-list refresh (Wikipedia)", cron: "0 4 * * 0", operation: "index.refresh_wikipedia", budgetCents: 1, enabled: true, timeZone: "UTC" },
  { id: "index-refresh-holdings", name: "Index-list refresh (ETF holdings)", cron: "0 3 * * *", operation: "index.refresh_holdings", budgetCents: 1, enabled: false, timeZone: "UTC" },
  // Issue #4411: the monthly Autopilot evaluation.
  { id: "autopilot-monthly-evaluation", name: "Autopilot monthly evaluation", cron: "0 9 1 * *", operation: "autopilot.evaluate", budgetCents: 1, enabled: true, timeZone: "UTC" },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let posted: { path: string; body: any }[];
let existingGoals: any[];
let failIds: Map<string, string>;

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

function installFetch() {
  posted = [];
  existingGoals = [];
  failIds = new Map();
  (globalThis as any).fetch = vi.fn(async (path: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    if (path === "/api/schedule/goals" && method === "GET") {
      return jsonResponse({ ok: true, goals: existingGoals });
    }
    if (path.startsWith("/api/schedule/ticks")) {
      return jsonResponse({ ok: true, ticks: [] });
    }
    if (path.startsWith("/api/schedule/runs")) {
      return jsonResponse({ ok: true, runs: [] });
    }
    if (path === "/api/schedule/operations" && method === "GET") {
      return jsonResponse({ ok: true, operations: OPERATIONS });
    }
    if (path === "/api/schedule/builtin-goals" && method === "GET") {
      return jsonResponse({ ok: true, goals: BUILTINS });
    }
    if (path === "/api/schedule/goals" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      posted.push({ path, body });
      const failure = failIds.get(body.id);
      if (failure) {
        return jsonResponse({ ok: false, error: failure }, 400);
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

function builtinSelect(): HTMLSelectElement {
  const el = container.querySelector('select[aria-label="Built-in goal"]') as HTMLSelectElement | null;
  if (!el) throw new Error("built-in goal select not found");
  return el;
}

function enabledCheckbox(): HTMLInputElement {
  const el = container.querySelector('input[aria-label="Enabled"]') as HTMLInputElement | null;
  if (!el) throw new Error("Enabled checkbox not found");
  return el;
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

describe("ScheduledGoalsPanel built-in goals (#3996)", () => {
  it("dropdown lists all 9 built-ins by name and id", async () => {
    await renderPanel();
    const select = builtinSelect();
    const options = Array.from(select.options).map((o) => o.textContent ?? "");
    expect(options).toHaveLength(10); // placeholder + 9 built-ins
    for (const goal of BUILTINS) {
      expect(options.some((t) => t.includes(goal.name) && t.includes(goal.id))).toBe(true);
    }
    expect(options.map((t) => t)).toEqual(
      expect.arrayContaining(["Daily QA sweep (daily-qa-sweep)", "SessionStore 70% cap alert (resource-cap-alert)"]),
    );
  });

  it("selecting a built-in fills the whole form, including the enabled state", async () => {
    await renderPanel();
    await act(async () => {
      setInput(builtinSelect(), "resource-cap-alert");
    });
    expect(inputByPlaceholder("id (e.g. weekly-report)").value).toBe("resource-cap-alert");
    expect(inputByPlaceholder("name").value).toBe("SessionStore 70% cap alert");
    expect(inputByPlaceholder('cron (e.g. "0 6 * * *")').value).toBe("0 * * * *");
    expect((container.querySelector('select[aria-label="operation"]') as HTMLSelectElement).value).toBe("resource.cap_alert");
    expect(inputByPlaceholder("budget in cents (e.g. 500)").value).toBe("1");
    expect(inputByPlaceholder("timeZone (IANA, e.g. UTC)").value).toBe("UTC");
    expect(enabledCheckbox().checked).toBe(true);
    // The Delegation Contract preview reflects the filled form.
    expect(container.textContent).toMatch(/Create scheduled goal "SessionStore 70% cap alert" \(id "resource-cap-alert"\)/);
    expect(container.textContent).toMatch(/Run operation "resource\.cap_alert" on schedule "0 \* \* \* \*" \(UTC\)/);
  });

  it("selecting a disabled-by-design built-in fills enabled off and its timeZone", async () => {
    await renderPanel();
    await act(async () => {
      setInput(builtinSelect(), "daily-social-post");
    });
    expect(inputByPlaceholder("id (e.g. weekly-report)").value).toBe("daily-social-post");
    expect(inputByPlaceholder("timeZone (IANA, e.g. UTC)").value).toBe("America/New_York");
    expect(inputByPlaceholder("budget in cents (e.g. 500)").value).toBe("1");
    expect(enabledCheckbox().checked).toBe(false);
    // Submitting carries the disabled state to the server.
    await act(async () => {
      buttonByText("Add goal").click();
    });
    await act(async () => {});
    expect(posted).toHaveLength(1);
    expect(posted[0].body).toMatchObject({ id: "daily-social-post", enabled: false, timeZone: "America/New_York" });
  });

  it("selecting a built-in without a timeZone leaves the form default", async () => {
    await renderPanel();
    await act(async () => {
      setInput(builtinSelect(), "daily-qa-sweep");
    });
    expect(inputByPlaceholder("id (e.g. weekly-report)").value).toBe("daily-qa-sweep");
    expect(inputByPlaceholder("budget in cents (e.g. 500)").value).toBe("500");
    expect(inputByPlaceholder("timeZone (IANA, e.g. UTC)").value).toBe("UTC");
    expect(enabledCheckbox().checked).toBe(true);
  });

  it("an already-present goal is marked in the dropdown and selecting it surfaces that it exists", async () => {
    existingGoals = [
      { id: "resource-cap-alert", name: "SessionStore 70% cap alert", cron: "0 * * * *", operation: "resource.cap_alert", budgetCents: 1, enabled: true, timeZone: "UTC" },
    ];
    await renderPanel();
    const options = Array.from(builtinSelect().options).map((o) => o.textContent ?? "");
    expect(options.some((t) => t.includes("resource-cap-alert") && t.toLowerCase().includes("already added"))).toBe(true);
    await act(async () => {
      setInput(builtinSelect(), "resource-cap-alert");
    });
    expect(container.textContent).toMatch(/already exists/i);
    // The form is not overwritten with the existing goal, and nothing posts.
    expect(inputByPlaceholder("id (e.g. weekly-report)").value).toBe("");
    expect(posted).toHaveLength(0);
  });

  it("seed-all adds only the missing goals in order, skips existing ones, and reports per-goal results", async () => {
    existingGoals = [
      { id: "resource-cap-alert", name: "SessionStore 70% cap alert", cron: "0 * * * *", operation: "resource.cap_alert", budgetCents: 1, enabled: true, timeZone: "UTC" },
    ];
    await renderPanel();
    await act(async () => {
      buttonByText("Seed all built-in goals").click();
    });
    await act(async () => {});
    expect(posted.map((p) => p.body.id)).toEqual([
      "daily-qa-sweep",
      "opportunity-hunt",
      "daily-social-post",
      "resource-daily-rollup",
      "resource-dashboard-comparison",
      "index-refresh-wikipedia",
      "index-refresh-holdings",
      "autopilot-monthly-evaluation",
    ]);
    // No duplicate is posted, and the two disabled-by-design goals seed disabled.
    expect(new Set(posted.map((p) => p.body.id)).size).toBe(posted.length);
    expect(posted.find((p) => p.body.id === "daily-social-post")?.body.enabled).toBe(false);
    expect(posted.find((p) => p.body.id === "index-refresh-holdings")?.body.enabled).toBe(false);
    expect(container.textContent).toMatch(/daily-qa-sweep.*Added/);
    expect(container.textContent).toMatch(/resource-cap-alert.*already exists/i);
  });

  it("seed-all never fails wholesale: one server refusal is failed, the rest still add", async () => {
    failIds = new Map([["resource-cap-alert", "Unknown operation: resource.cap_alert"]]);
    await renderPanel();
    await act(async () => {
      buttonByText("Seed all built-in goals").click();
    });
    await act(async () => {});
    expect(posted.map((p) => p.body.id)).toEqual(BUILTINS.map((g) => g.id));
    expect(container.textContent).toMatch(/resource-cap-alert.*Failed/);
    expect(container.textContent).toMatch(/daily-qa-sweep.*Added/);
  });
});
