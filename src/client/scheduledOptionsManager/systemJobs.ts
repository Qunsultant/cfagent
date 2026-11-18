import type { CreatableJob, SystemJobInfo } from "./types";

export const SYSTEM_JOBS: Record<string, SystemJobInfo> = {
  autonomousMarketScreen: {
    label: "Stock Market Screen",
    description: "Screens the selected live stock universe with E*TRADE quotes and generates a PDF report.",
    triggerRoute: "/api/schedules/trigger-screen",
  },
  autonomousOptionsAnalysis: {
    label: "Options Market Screen",
    description: "Screens the selected live universe against E*TRADE option chains and generates a report.",
    triggerRoute: "/api/schedules/trigger-options-analysis",
  },
  autonomousStrategyDiscovery: {
    label: "Strategy Discovery",
    description:
      "Re-runs saved discovery views (symbol, thesis, target) captured from the discovery panel against the live E*TRADE chain and stores the ranked results.",
    triggerRoute: "/api/schedules/trigger-discovery",
  },
  // Issue #3121 #4238 — the daily IV history collection (#15): one
  // ATM IV record per tracked name per day; names whose chains fail
  // are reported failed, never fabricated. The trigger route is the
  // existing manual-trigger path (the ScheduledOptionsManager card
  // already handles its result shape).
  collectIvHistory: {
    label: "Scheduled IV collection",
    description:
      "Collects one ATM IV record per tracked name per day; names whose chains fail are reported failed in the run's audit — no record is ever fabricated for a missing day.",
    triggerRoute: "/api/schedules/trigger-iv-collection",
  },
};

/**
 * Callback → its on-demand trigger route. Callbacks absent here
 * (sendScheduledReminder, expireStaleOrderDraft, executeAsyncJob, …)
 * have no trigger route and render no Trigger control — a card's
 * Trigger always runs that card's own job, never a different one.
 */
export const TRIGGER_ROUTES: Record<string, string> = {
  autonomousOptionsAnalysis: "/api/schedules/trigger-options-analysis",
  autonomousMarketScreen: SYSTEM_JOBS.autonomousMarketScreen.triggerRoute,
  autonomousStrategyDiscovery: SYSTEM_JOBS.autonomousStrategyDiscovery.triggerRoute,
  // Issue #3121 #4238 — IV collection's existing manual-trigger route.
  collectIvHistory: "/api/schedules/trigger-iv-collection",
};

export function systemJobFor(callback: unknown): SystemJobInfo | undefined {
  return typeof callback === "string" ? SYSTEM_JOBS[callback] : undefined;
}

export function triggerRouteFor(callback: unknown): string | undefined {
  return typeof callback === "string" ? TRIGGER_ROUTES[callback] : undefined;
}

export const JOB_CALLBACKS: Record<CreatableJob, string> = {
  optionsAnalysis: "autonomousOptionsAnalysis",
  marketScreen: "autonomousMarketScreen",
  strategyDiscovery: "autonomousStrategyDiscovery",
};
