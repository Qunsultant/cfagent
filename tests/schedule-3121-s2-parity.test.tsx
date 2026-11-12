/** @vitest-environment jsdom */
/**
 * Issue #3121 Slice S2 — consolidated schedules surfaces (one home,
 * sub-routes, de-hubbed).
 *
 * Parity for the S2 slice of the scheduling consolidation program:
 * the `?tab=schedules` home with its sub-route scheme, the de-hubbing
 * (the home renders from the shell, not through the retained
 * ETradeTradingHub), the retired duplicate/outpost addresses
 * (redirects), the role-gated queue view, and the consolidated run
 * ledger view over the S1 ledger.
 *
 * Coverage:
 * - S2-P01 sub-route parsing: view ids, the `ledger` alias, the run
 *   default, `schedule=` / `run=` deep links, invalid views.
 * - S2-P02 retired addresses: the four redirects and the nulls (incl.
 *   U-03, which is deliberately NOT redirected — real
 *   options-research state).
 * - S2-P03 de-hub: route no longer retained, shell renders the home,
 *   no hub mapping, no hub schedules branch.
 * - S2-P04 nav active logic: the Schedules item is active exactly on
 *   the home; no screeners address activates it.
 * - S2-P05 router param scoping: `schedule` / `run` are owned by the
 *   home (kept on arrival, dropped on departure).
 * - S2-P06 ledger helpers: merge (newest-first, legacy normalized),
 *   filter (schedule / run), null linkage renders as "—".
 * - S2-P07 queue gate probe: the 403/Forbidden refusal test.
 * - S2-P08 wiring pins: the home renders the four views, the queue
 *   view probes before mounting, the focus prop exists, the redirect
 *   runs in the shell, the admin deep links land on the home.
 * - S2-P09 ledger panel: a legacy row (no linkage) and a linked row
 *   both render — the legacy row is never dropped, its nulls show
 *   as "—" and its trigger as "unknown".
 * - S2-P10 queue view: a 403 overview probe shows the denied state
 *   and never mounts the wipe panel; a passing probe mounts it.
 * - S2-P11 home: the four tabs render, list is the default, the run
 *   ledger view loads over the S1 ledger.
 * - S2-P12 schedule deep link: `focusScheduleId` opens the detail
 *   dialog for a listed schedule and reports a missing id.
 * - S2-P13 one of everything (owner mandate, #3121 comment 6660031391):
 *   one UX (one home, no hub duplicate, no admin outpost), one ledger
 *   read path (the ledger view reuses the JobsPanel reads), no new
 *   Cloudflare surface in the home's pure module.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
function read(rel: string): string {
  return readFileSync(join(here, "..", rel), "utf8").replace(/\r\n/g, "\n");
}

import {
  SCHEDULES_HOME_TAB,
  SCHEDULES_HOME_VIEWS,
  isSchedulesHomeView,
  normalizeSchedulesHomeView,
  parseSchedulesDeepLink,
  legacySchedulesRedirect,
} from "../src/client/schedulesHomeView";
import {
  mergeLedgerRuns,
  filterLedgerRuns,
  ledgerLinkageCell,
  ledgerLinkageTitle,
  ScheduleRunLedgerPanel,
} from "../src/client/ScheduleRunLedgerPanel";
import { isOverviewGateRefusal, ScheduleQueueView } from "../src/client/ScheduleQueueView";
import { SchedulesHome } from "../src/client/SchedulesHome";
import { SchedulesPanel } from "../src/client/SchedulesPanel";
import { ToastProvider } from "../src/client/components/ui/Toast";
import { getRoute } from "../src/client/routes";
import { TRADING_TABS } from "../src/client/chat/types";
import {
  buildSearchWithTab,
  TAB_PARAM_OWNERS,
} from "../src/client/router";
import {
  buildDefaultLeftNavConfig,
  findNavItemConfig,
  isNavItemOrSubItemActive,
} from "../src/client/navConfig";
import {
  OPTIONS_HUB_TABS,
  isValidOptionsHubTab,
  optionsHubTabForResearch,
} from "../src/client/OptionsHub";
import { researchSurfaceForParam } from "../src/client/options/researchSurface";
import { ResearchRunsPanel } from "../src/client/options/ResearchRunsPanel";
import type { JobRunRecord } from "../src/services/jobRunRecords";

describe("S2-P01 sub-route parsing — view ids, ledger alias, deep links (#3121)", () => {
  it("defaults to list, accepts every view id, and aliases ledger to runs", () => {
    expect(parseSchedulesDeepLink("?tab=schedules")).toEqual({
      view: "list",
      scheduleId: null,
      runId: null,
    });
    expect(parseSchedulesDeepLink("?tab=schedules&view=runs").view).toBe("runs");
    expect(parseSchedulesDeepLink("?tab=schedules&view=ledger").view).toBe("runs");
    expect(parseSchedulesDeepLink("?tab=schedules&view=goals").view).toBe("goals");
    expect(parseSchedulesDeepLink("?tab=schedules&view=queue").view).toBe("queue");
    expect(parseSchedulesDeepLink("?tab=schedules&view=bogus").view).toBe("list");
  });

  it("carries schedule= and run= deep links, and a run defaults the view to runs", () => {
    expect(parseSchedulesDeepLink("?tab=schedules&schedule=sched-1")).toEqual({
      view: "list",
      scheduleId: "sched-1",
      runId: null,
    });
    expect(parseSchedulesDeepLink("?tab=schedules&run=job-9")).toEqual({
      view: "runs",
      scheduleId: null,
      runId: "job-9",
    });
    expect(
      parseSchedulesDeepLink("?tab=schedules&view=runs&schedule=sched-1&run=job-9"),
    ).toEqual({ view: "runs", scheduleId: "sched-1", runId: "job-9" });
    expect(parseSchedulesDeepLink("?tab=schedules&schedule=  ").scheduleId).toBeNull();
  });

  it("the view vocabulary is exactly the four home views", () => {
    expect([...SCHEDULES_HOME_VIEWS]).toEqual(["list", "runs", "goals", "queue"]);
    expect(SCHEDULES_HOME_TAB).toBe("schedules");
    expect(isSchedulesHomeView("ledger")).toBe(false);
    expect(normalizeSchedulesHomeView("ledger")).toBe("runs");
    expect(normalizeSchedulesHomeView("bogus", true)).toBe("runs");
    expect(normalizeSchedulesHomeView("bogus", false)).toBe("list");
  });
});

describe("S2-P02 retired addresses — five redirects, including U-03 (#3121)", () => {
  it("redirects the duplicate, the three admin outposts, and U-03 to the home", () => {
    expect(legacySchedulesRedirect("?tab=screeners&view=schedules")).toEqual({
      tab: "schedules",
    });
    expect(legacySchedulesRedirect("?tab=platform-admin&view=scheduled-goals")).toEqual({
      tab: "schedules",
      view: "goals",
    });
    expect(legacySchedulesRedirect("?tab=platform-admin&view=jobs")).toEqual({
      tab: "schedules",
      view: "runs",
    });
    expect(
      legacySchedulesRedirect("?tab=platform-admin&view=iaaa-admin&iaaaTab=queue"),
    ).toEqual({ tab: "schedules", view: "queue" });
    // U-03 (owner decision, #3121 comment 6669207975): the OptionsHub
    // scheduled-screening address redirects to the home, reversing
    // S2's keep-as-is. Its options-research content relocated to the
    // Options Runs tab (see U-03 relocation pins below).
    expect(legacySchedulesRedirect("?tab=options&view=scheduled-screening")).toEqual({
      tab: "schedules",
    });
  });

  it("leaves every other address alone — including iaaa-admin without queue", () => {
    expect(legacySchedulesRedirect("?tab=schedules")).toBeNull();
    expect(legacySchedulesRedirect("?tab=schedules&view=runs")).toBeNull();
    expect(legacySchedulesRedirect("?tab=platform-admin&view=ads")).toBeNull();
    expect(legacySchedulesRedirect("?tab=platform-admin&view=iaaa-admin")).toBeNull();
    expect(
      legacySchedulesRedirect("?tab=platform-admin&view=iaaa-admin&iaaaTab=members"),
    ).toBeNull();
    expect(legacySchedulesRedirect("?tab=screeners&view=forex")).toBeNull();
    expect(legacySchedulesRedirect("?tab=options&view=options-runs")).toBeNull();
  });
});

describe("U-03 redirect — the scheduled-screening mode is gone; its content lives on Options Runs (#3121)", () => {
  it("the hub has no scheduled-screening tab and the legacy research surface is gone", () => {
    expect(OPTIONS_HUB_TABS).not.toContain("scheduled-screening");
    expect(isValidOptionsHubTab("scheduled-screening")).toBe(false);
    expect(optionsHubTabForResearch("schedules")).toBeNull();
    expect(researchSurfaceForParam("schedules")).toBeNull();
    const hub = read("src/client/OptionsHub.tsx");
    expect(hub).not.toContain("scheduled-screening");
    const panel = read("src/client/options/OptionsResearchPanel.tsx");
    expect(panel).not.toContain('researchMode === "schedules"');
    expect(panel).not.toContain('id: "schedules"');
    expect(panel).not.toContain("onOpenSchedules");
    const config = JSON.parse(read("src/client/nav-config.json")) as {
      deepLinkSurfaces: Array<{ page: string; values: string[] }>;
    };
    const optionsHub = config.deepLinkSurfaces.find((s) => s.page === "options");
    expect(optionsHub).toBeDefined();
    expect(optionsHub!.values).not.toContain("scheduled-screening");
  });

  it("the three relocated sections render on the Options Runs tab", async () => {
    const panel = read("src/client/options/ResearchRunsPanel.tsx");
    expect(panel).toContain("ScheduledOptionsRunForm");
    expect(panel).toContain("AutonomousOptionsRuns");
    expect(panel).toContain("ScreeningActivityPanel");
    fetchStub((url) => {
      if (url.includes("/api/research/settings")) return { status: 200, body: { config: {} } };
      if (url.includes("/api/research/latest")) return { status: 200, body: { latest: null } };
      if (url.includes("/api/research/history")) return { status: 200, body: { history: [] } };
      if (url.includes("/api/options/latest")) return { status: 200, body: { runs: [] } };
      if (url.includes("/api/screening/activity")) return { status: 200, body: { feed: [] } };
      if (url.includes("/api/screening/controls")) {
        return {
          status: 200,
          body: {
            rolloutStage: "internal",
            channelsEnabled: false,
            nlqFitDiscovery: false,
            weightsV2Ranking: false,
            scheduledPaused: false,
          },
        };
      }
      return null;
    });
    await render(<ResearchRunsPanel activeEnv="TEST" userLogin="tester" />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("Run the Options Market Screen now");
    expect(text).toContain("Autonomous Options Runs");
    expect(text).toContain("Autonomous Screening Activity");
  });
});

describe("S2-P03 de-hub — the home renders from the shell, not the hub (#3121)", () => {
  it("the schedules route is no longer retained, and the shell owns it", () => {
    expect(getRoute("schedules")).toBeDefined();
    expect(getRoute("schedules")).not.toMatchObject({ retain: true });
    expect(TRADING_TABS.has("schedules")).toBe(false);
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain('import { SchedulesHome } from "./SchedulesHome";');
    expect(chat).toContain("schedules: (\n      <SchedulesHome");
    expect(chat).toContain("de-hubbed (#3121 S2)");
  });

  it("no hub mapping and no hub schedules branch remain", () => {
    const types = read("src/client/chat/types.ts");
    expect(types).not.toContain('case "schedules":\n      return "schedules";');
    expect(types).toContain("de-hubbed");
    const hub = read("src/client/ETradeTradingHub.tsx");
    expect(hub).not.toContain('effectiveSubTab === "schedules"');
    expect(hub).not.toContain('from "./SchedulesPanel"');
    expect(hub).toContain("#3121 S2: the schedules branch is gone");
  });

  it("the route description names the home, not the screening hub", () => {
    const config = JSON.parse(read("src/client/nav-config.json")) as {
      routes: Array<Record<string, unknown>>;
    };
    const route = config.routes.find((r) => r.id === "schedules");
    expect(route).toBeDefined();
    expect(route!.description as string).toContain("The one scheduling surface");
  });
});

describe("S2-P04 nav active logic — Schedules is active exactly on the home (#3121)", () => {
  it("activates on ?tab=schedules and on no screeners address", () => {
    const config = buildDefaultLeftNavConfig();
    const item = findNavItemConfig(config, "schedules");
    expect(item).toBeDefined();
    expect(isNavItemOrSubItemActive(item!, "schedules")).toBe(true);
    expect(isNavItemOrSubItemActive(item!, "screeners")).toBe(false);
    expect(isNavItemOrSubItemActive(item!, "platform-admin")).toBe(false);
    expect(isNavItemOrSubItemActive(item!, "options")).toBe(false);
  });
});

describe("S2-P05 router param scoping — schedule/run are the home's own params (#3121)", () => {
  it("the registry owns schedule on schedules and run on schedules + workflow-runs", () => {
    expect(TAB_PARAM_OWNERS.schedule).toEqual(["schedules"]);
    expect([...(TAB_PARAM_OWNERS.run ?? [])].sort()).toEqual(["schedules", "workflow-runs"]);
  });

  it("keeps the deep links on arrival at the home and drops them on departure", () => {
    // Home-owned params survive arrival at the home — that IS the
    // #3238 scoping rule: schedule/run belong to schedules.
    expect(
      buildSearchWithTab("?tab=platform-admin&schedule=s1&run=r1", "schedules"),
    ).toBe("?tab=schedules&schedule=s1&run=r1");
    expect(
      buildSearchWithTab("?tab=schedules&view=runs&schedule=s1&run=r1", "schedules"),
    ).toBe("?tab=schedules&view=runs&schedule=s1&run=r1");
    expect(buildSearchWithTab("?tab=schedules&schedule=s1", "portfolio")).toBe(
      "?tab=portfolio",
    );
    expect(buildSearchWithTab("?tab=workflow-runs&run=r1", "schedules")).toBe(
      "?tab=schedules&run=r1",
    );
  });
});

describe("S2-P06 ledger helpers — merge, filter, null linkage (#3121)", () => {
  const linked: JobRunRecord = {
    system: "orchestrator-schedule",
    jobId: "sched-1",
    operation: "autonomousMarketScreen",
    started: "2026-11-05T10:00:00.000Z",
    finished: "2026-11-05T10:01:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
    trigger: "scheduled",
    scheduleId: "sched-1",
    asyncJobId: "job-1",
    workflowId: "wf-1",
    descriptor: "ok",
  };
  const legacy: JobRunRecord = {
    system: "scheduled-agent-goal",
    jobId: "daily-qa-sweep",
    operation: "qa.sweep",
    started: "2026-11-05T09:30:00.000Z",
    finished: "2026-11-05T09:31:00.000Z",
    outcome: "success",
    triggeredBy: "scheduled",
  };

  it("merges newest-first and normalizes a legacy row instead of dropping it", () => {
    const merged = mergeLedgerRuns([linked], [legacy]);
    expect(merged).toHaveLength(2);
    expect(merged[0].jobId).toBe("sched-1");
    expect(merged[1].jobId).toBe("daily-qa-sweep");
    expect(merged[1].trigger).toBe("unknown");
    expect(merged[1].scheduleId).toBeNull();
    expect(merged[1].asyncJobId).toBeNull();
    expect(merged[1].workflowId).toBeNull();
  });

  it("filters by schedule (id or jobId) and by run (jobId)", () => {
    const runs = mergeLedgerRuns([linked], [legacy]);
    expect(filterLedgerRuns(runs, "sched-1", null).map((r) => r.jobId)).toEqual([
      "sched-1",
    ]);
    expect(filterLedgerRuns(runs, "daily-qa-sweep", null).map((r) => r.jobId)).toEqual([
      "daily-qa-sweep",
    ]);
    expect(filterLedgerRuns(runs, null, "daily-qa-sweep").map((r) => r.jobId)).toEqual([
      "daily-qa-sweep",
    ]);
    expect(filterLedgerRuns(runs, null, null)).toHaveLength(2);
  });

  it("a null linkage id renders as an em dash, never as an empty cell", () => {
    expect(ledgerLinkageCell(null)).toBe("—");
    expect(ledgerLinkageCell(undefined)).toBe("—");
    expect(ledgerLinkageCell("wf-1")).toBe("wf-1");
    expect(ledgerLinkageTitle(null)).toBe("not applicable");
    expect(ledgerLinkageTitle("wf-1")).toBe("wf-1");
  });
});

describe("S2-P07 queue gate probe — the 403/Forbidden refusal test (#3121)", () => {
  it("treats the overview gate refusal as denied and nothing else as denied", () => {
    expect(isOverviewGateRefusal("Request failed (403)")).toBe(true);
    expect(isOverviewGateRefusal("Forbidden")).toBe(true);
    expect(isOverviewGateRefusal("Request failed (500)")).toBe(false);
    expect(isOverviewGateRefusal("Unexpected IAAA overview response.")).toBe(false);
    expect(isOverviewGateRefusal("")).toBe(false);
  });
});

describe("S2-P08 wiring pins — the home, the gate, the focus, the redirect (#3121)", () => {
  it("the home renders all four views through the ui primitives", () => {
    const home = read("src/client/SchedulesHome.tsx");
    expect(home).toContain("<SchedulesPanel");
    expect(home).toContain("<ScheduleRunLedgerPanel");
    expect(home).toContain("<ScheduledGoalsPanel embedded />");
    expect(home).toContain("<ScheduleQueueView />");
    expect(home).toContain('idBase="schedules-home"');
    expect(home).toContain("focusScheduleId={deepLink.scheduleId}");
  });

  it("the queue view probes the overview gate before mounting the wipe panel", () => {
    const view = read("src/client/ScheduleQueueView.tsx");
    expect(view).toContain("fetchAdminOverview()");
    expect(view).toContain("isOverviewGateRefusal");
    expect(view).toContain('title="Not an IAAA admin"');
    expect(view).toContain("<AdminQueueWipePanel />");
    expect(view).toContain("tenant-admin-gated wipe surface does not exist yet");
  });

  it("the shell applies the legacy redirect with a replace on arrival and on route change", () => {
    const chat = read("src/client/Chat.tsx");
    expect(chat).toContain("legacySchedulesRedirect(window.location.search)");
    expect(chat).toContain("replaceToTab(redirect.tab, redirect.view, redirect.params)");
    const router = read("src/client/router.ts");
    expect(router).toContain("export function replaceToTab");
    expect(router).toContain("window.history.replaceState");
  });

  it("the admin deep links land straight on the home", () => {
    const config = JSON.parse(read("src/client/nav-config.json")) as {
      deepLinks: Record<string, unknown>;
    };
    expect(config.deepLinks["platform-admin:scheduled-goals"]).toEqual({
      tab: "schedules",
      view: "goals",
    });
    expect(config.deepLinks["platform-admin:jobs"]).toEqual({
      tab: "schedules",
      view: "runs",
    });
    // U-03's deep link is gone with the mode it pointed at — the
    // address redirects to the home, and the content it carried now
    // lives on the Options Runs tab.
    expect(config.deepLinks["options-screener:scheduled-screening"]).toBeUndefined();
  });

  it("the list panel accepts a focus schedule id", () => {
    const panel = read("src/client/SchedulesPanel.tsx");
    expect(panel).toContain("focusScheduleId?: string | null;");
    expect(panel).toContain("focusScheduleId");
    expect(panel).toContain("Schedule not found");
  });
});

// --- jsdom component tests ---

let container: HTMLDivElement;
let root: Root | null = null;

async function render(node: React.ReactNode) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(node);
  });
}

async function settle(times = 4) {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  window.history.pushState(null, "", "/?tab=schedules");
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(async () => {
  await act(async () => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  vi.unstubAllGlobals();
});

function fetchStub(
  handler: (url: string) => { status: number; body: unknown } | null,
) {
  (globalThis.fetch as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    async (input: unknown) => {
      const url = String(input);
      const hit = handler(url);
      if (!hit) throw new Error(`unexpected fetch: ${url}`);
      return new Response(JSON.stringify(hit.body), { status: hit.status });
    },
  );
}

const LINKED_RUN = {
  system: "orchestrator-schedule",
  jobId: "sched-1",
  operation: "autonomousMarketScreen",
  started: "2026-11-05T10:00:00.000Z",
  finished: "2026-11-05T10:01:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
  trigger: "scheduled",
  scheduleId: "sched-1",
  asyncJobId: "job-1",
  workflowId: "wf-1",
  descriptor: "Scanned 400 symbols",
};

const LEGACY_RUN = {
  system: "scheduled-agent-goal",
  jobId: "daily-qa-sweep",
  operation: "qa.sweep",
  started: "2026-11-05T09:30:00.000Z",
  finished: "2026-11-05T09:31:00.000Z",
  outcome: "success",
  triggeredBy: "scheduled",
};

const OVERVIEW = {
  tenantId: "primary",
  callerInternalUserId: "11111111-1111-4111-8111-111111111111",
  memberships: [
    {
      membershipId: "m-1",
      internalUserId: "11111111-1111-4111-8111-111111111111",
      tenantId: "primary",
      roleBindings: [{ role: "platform-admin", scope: "platform", grantedBy: "system:bootstrap-genesis" }],
      createdBy: "system:bootstrap-genesis",
      createdAtMs: 1792660000000,
    },
  ],
  genesis: { platformGenesisOccurred: true },
  recentAuditEvents: [],
};

describe("S2-P09 ledger panel — legacy and linked rows both render, nulls as dashes (#3121)", () => {
  it("renders the four linkage columns with nulls as '—' and trigger 'unknown'", async () => {
    fetchStub((url) => {
      // The one merged read (#3123): the server merges both halves,
      // so the stub serves both rows on the one endpoint.
      if (url.includes("/api/ledger/runs")) return { status: 200, body: { runs: [LINKED_RUN, LEGACY_RUN] } };
      return null;
    });
    await render(<ScheduleRunLedgerPanel />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("sched-1");
    expect(text).toContain("daily-qa-sweep");
    expect(text).toContain("job-1");
    expect(text).toContain("wf-1");
    // The legacy row's nulls render as em dashes (four linkage cells:
    // schedule/async/workflow are "—"; trigger reads "unknown").
    expect(text).toContain("unknown");
    expect(text).toContain("—");
    expect(text).toContain("Trigger");
    expect(text).toContain("Async job");
    expect(text).toContain("Workflow");
  });

  it("a run filter shows only that job's history", async () => {
    fetchStub((url) => {
      // The one merged read (#3123), filtered by jobId server-side;
      // the stub emulates the filter by returning only the matching row.
      if (url.includes("/api/ledger/runs")) return { status: 200, body: { runs: [LEGACY_RUN] } };
      return null;
    });
    await render(<ScheduleRunLedgerPanel runId="daily-qa-sweep" />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("daily-qa-sweep");
    expect(text).not.toContain("sched-1");
    expect(text).toContain("Showing runs for");
  });
});

describe("S2-P10 queue view — denied without the probe, mounted with it (#3121)", () => {
  it("a 403 overview probe shows the denied state and never mounts the wipe panel", async () => {
    fetchStub((url) => {
      if (url.includes("/api/iaaa/overview")) {
        return { status: 403, body: { error: "Forbidden" } };
      }
      return null;
    });
    await render(<ScheduleQueueView />);
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("Not an IAAA admin");
    expect(text).toContain("only available to platform admins");
    expect(text).not.toContain("Queue dump");
  });

  it("a passing probe mounts the wipe panel", async () => {
    fetchStub((url) => {
      if (url.includes("/api/iaaa/overview")) return { status: 200, body: OVERVIEW };
      if (url === "/api/schedules") return { status: 200, body: { schedules: [] } };
      return null;
    });
    await render(<ScheduleQueueView />);
    await settle(6);
    const text = container.textContent ?? "";
    expect(text).toContain("Queue dump");
    expect(text).toContain("0 schedule(s)");
    expect(text).toContain("No schedules in this instance queue.");
  });
});

describe("S2-P11 home — four tabs, list default, ledger view loads (#3121)", () => {
  it("renders the four view tabs and the list view by default", async () => {
    fetchStub((url) => {
      if (url === "/api/schedules") return { status: 200, body: { schedules: [] } };
      return null;
    });
    await render(
      <ToastProvider>
        <SchedulesHome />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')).map(
      (t) => t.textContent ?? "",
    );
    expect(tabs).toEqual(["Schedules", "Run ledger", "Goal schedules", "Queue"]);
    expect(container.textContent).toContain("The one scheduling surface");
  });

  it("switching to Run ledger loads the consolidated ledger", async () => {
    fetchStub((url) => {
      if (url === "/api/schedules") return { status: 200, body: { schedules: [] } };
      // The one merged read (#3123): both halves on the one endpoint.
      if (url.includes("/api/ledger/runs")) return { status: 200, body: { runs: [LINKED_RUN] } };
      return null;
    });
    await render(
      <ToastProvider>
        <SchedulesHome />
      </ToastProvider>,
    );
    await settle();
    const tabs = Array.from(container.querySelectorAll('[role="tab"]'));
    const ledgerTab = tabs.find((t) => t.textContent?.includes("Run ledger")) as HTMLElement;
    await act(async () => {
      ledgerTab.click();
    });
    await settle();
    const text = container.textContent ?? "";
    expect(window.location.search).toContain("view=runs");
    expect(text).toContain("sched-1");
    expect(text).toContain("job-1");
  });
});

describe("S2-P12 schedule deep link — focus opens the detail, a missing id reports (#3121)", () => {
  it("opens the detail dialog for the focused schedule once loaded", async () => {
    fetchStub((url) => {
      if (url === "/api/schedules") {
        return {
          status: 200,
          body: {
            schedules: [
              { id: "sched-1", type: "cron", callback: "autonomousMarketScreen", cron: "0 3 * * *" },
            ],
          },
        };
      }
      if (url === "/api/schedules/sched-1") {
        return { status: 200, body: { id: "sched-1", callback: "autonomousMarketScreen" } };
      }
      return null;
    });
    await render(
      <ToastProvider>
        <SchedulesPanel focusScheduleId="sched-1" />
      </ToastProvider>,
    );
    await settle(6);
    // The detail modal portals to document.body (ui Modal), not the
    // render container.
    expect(document.body.querySelector('[aria-label^="Details for"]')).toBeTruthy();
  });

  it("reports a focused id that is not in the list", async () => {
    fetchStub((url) => {
      if (url === "/api/schedules") return { status: 200, body: { schedules: [] } };
      return null;
    });
    await render(
      <ToastProvider>
        <SchedulesPanel focusScheduleId="nope" />
      </ToastProvider>,
    );
    await settle();
    const text = container.textContent ?? "";
    expect(text).toContain("Schedule not found");
    expect(text).toContain("nope");
  });
});

describe("S2-P13 one of everything — one UX, one ledger read path, pure core (#3121)", () => {
  it("the ledger view reuses the JobsPanel reads instead of a second read path", () => {
    const ledger = read("src/client/ScheduleRunLedgerPanel.tsx");
    expect(ledger).toContain('from "./jobsApi"');
    // Issue #3121 Phase 2 (#3123) — the one merged ledger read.
    expect(ledger).toContain("listAllRuns");
    expect(ledger).not.toContain("listScheduleRuns");
    expect(ledger).not.toContain("listGoalRuns");
    expect(ledger).not.toContain("fetch(`/api/schedules/runs");
    expect(ledger).not.toContain("fetch(`/api/schedule/runs");
  });

  it("the home's pure module uses no Cloudflare, no fetch, no window", () => {
    const home = read("src/client/schedulesHomeView.ts");
    // The header comment names the absence; assert on usage, not the word.
    expect(home).not.toContain("window.");
    expect(home).not.toContain("typeof window");
    expect(home).not.toContain("fetch(");
    expect(home).not.toContain("cloudflare");
    expect(home).not.toContain("from \"./router\"");
  });

  it("no second schedules surface remains: the admin panels host no schedule mount", () => {
    const admin = read("src/client/PlatformAdminPage.tsx");
    expect(admin).not.toContain("<ScheduledGoalsPanel");
    expect(admin).not.toContain("<JobsPanel");
    const iaaa = read("src/client/IaaaAdminPanel.tsx");
    expect(iaaa).not.toContain("<AdminQueueWipePanel");
    expect(iaaa).not.toContain('"queue"');
  });
});
