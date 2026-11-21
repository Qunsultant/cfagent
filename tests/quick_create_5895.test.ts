/**
 * Issue #5895 — quick-create schedules for each job with defaults, then edit.
 *
 * Bulk create from the one job catalogue (#5880): the plan lists the jobs
 * the create form offers (the catalogue's form jobs, in catalogue order),
 * each with its default schedule / universe / delivery; all creatable jobs
 * are ticked by default; one action creates them through the existing
 * POST /api/schedules/create route (no new route, no second defaults
 * list); each created row is then editable in place like any other row.
 *
 * Scope notes (see the issue + PR body):
 * - Only the form jobs are quick-creatable. The other creatable callbacks
 *   need owner input with no catalogue default (autonomousGoalScreen needs
 *   a goalKind or scenarioId; runPipelineJobSchedule needs a pipeline job
 *   id), goal operations are created as goals (addGoal, not the create
 *   route), derived duties are system-derived, and internal callbacks are
 *   rejected by the route's allow-list. Listing those 33 would post
 *   guaranteed failures.
 * - Strategy discovery is listed but blocked: it needs a saved discovery
 *   view (symbol + target + date + loss), and inventing one would be fake
 *   data. It is unticked, disabled, and names its reason.
 * - The default cadence is the form's default cron (weekdays 9:30 AM ET),
 *   not the form's default interval (3600s): the owner's daily-defaults
 *   directive says defaults are daily, nothing more frequent, and a
 *   sub-daily cadence would need an explicit per-schedule opt-in (#4235).
 *   A catalogue defaultCron, when a form job carries one, wins over the
 *   form default — a config change moves the default, no code change.
 */
import { describe, it, expect, afterEach, vi } from "vitest";

vi.mock("agents", () => ({
  routeAgentRequest: async () => null,
  Agent: class MockAgent {
    ctx: any;
    env: any;
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

import {
  getJobCatalogue,
  getJobCatalogueAgents,
  setJobCatalogue,
  creatableJobCatalogueEntries,
  type JobCatalogueFile,
} from "../src/config/jobCatalogue";
import { cadenceNeedsOptIn } from "../src/client/scheduledOptionsManager/format";
import { validateScheduleCriteriaClient } from "../src/client/scheduledOptionsManager/payloadBuilders";
import {
  quickCreateJobs,
  quickCreateFormState,
  buildQuickCreateSubmission,
  runQuickCreate,
  type QuickCreateJob,
} from "../src/client/scheduledOptionsManager/quickCreate";

/** A winter date (EST, UTC-5): 9:30 AM ET is 14:30 UTC. */
const WINTER = new Date("2026-11-21T12:00:00Z");

afterEach(() => {
  setJobCatalogue(null);
});

function withJob(id: string, patch: Record<string, unknown>): JobCatalogueFile {
  const jobs = getJobCatalogue().map((j) => ({ ...j }));
  const target = jobs.find((j) => j.id === id);
  if (!target) throw new Error(`test helper: no catalogue job ${id}`);
  Object.assign(target, patch);
  return { version: 1, agents: getJobCatalogueAgents().map((a) => ({ ...a })), jobs };
}

function selectedJobs(): QuickCreateJob[] {
  return quickCreateJobs(WINTER).filter((job) => job.selected);
}

describe("5895 the quick-create plan comes from the one catalogue", () => {
  it("lists exactly the form jobs, in catalogue order, with catalogue labels", () => {
    const jobs = quickCreateJobs(WINTER);
    expect(jobs.map((job) => job.formJob)).toEqual(
      creatableJobCatalogueEntries().map((entry) => entry.formJob),
    );
    expect(jobs.map((job) => job.formJob)).toEqual([
      "optionsAnalysis",
      "marketScreen",
      "strategyDiscovery",
    ]);
    expect(jobs.map((job) => job.entry.label)).toEqual([
      "Autonomous Options Analysis",
      "Autonomous Market Screen (Stocks)",
      "Saved-View Strategy Discovery",
    ]);
  });

  it("follows a catalogue edit: a relabelled form job relabels the plan row", () => {
    setJobCatalogue(withJob("autonomousMarketScreen", { label: "Renamed Market Screen" }));
    const jobs = quickCreateJobs(WINTER);
    expect(jobs.find((job) => job.formJob === "marketScreen")?.entry.label).toBe(
      "Renamed Market Screen",
    );
  });

  it("honours a catalogue defaultCron when a form job carries one", () => {
    setJobCatalogue(withJob("autonomousMarketScreen", { defaultCron: "0 8 * * 1-5" }));
    const jobs = quickCreateJobs(WINTER);
    expect(jobs.find((job) => job.formJob === "marketScreen")?.defaultCron).toBe("0 8 * * 1-5");
  });
});

describe("5895 tick-to-create: all creatable jobs ticked, discovery blocked", () => {
  it("ticks options + market screens by default", () => {
    const jobs = quickCreateJobs(WINTER);
    expect(jobs.find((job) => job.formJob === "optionsAnalysis")?.selected).toBe(true);
    expect(jobs.find((job) => job.formJob === "marketScreen")?.selected).toBe(true);
  });

  it("leaves strategy discovery unticked: it needs a saved view, and none is invented", () => {
    const jobs = quickCreateJobs(WINTER);
    const discovery = jobs.find((job) => job.formJob === "strategyDiscovery");
    expect(discovery?.selected).toBe(false);
    expect(discovery?.blockedReason).toMatch(/saved (discovery )?view/i);
  });
});

describe("5895 per-job defaults: schedule, universe, delivery", () => {
  it("defaults to the form's weekday 9:30 AM ET cron (daily — no sub-daily opt-in)", () => {
    const jobs = quickCreateJobs(WINTER);
    for (const job of selectedJobs()) {
      expect(job.defaultCron).toBe("30 14 * * 1-5");
      expect(cadenceNeedsOptIn("cron", job.defaultCron)).toBe(false);
    }
    expect(jobs.every((job) => job.defaultCron === "30 14 * * 1-5")).toBe(true);
  });

  it("defaults the screens to NASDAQ100 with the form's Slack delivery", () => {
    for (const job of selectedJobs()) {
      expect(job.defaultUniverse).toBe("NASDAQ100");
      expect(job.defaultSlackChannel).toBe("#options-alerts");
    }
  });

  it("builds the form state from those defaults (cron cadence, no opt-in)", () => {
    const job = quickCreateJobs(WINTER).find((j) => j.formJob === "marketScreen")!;
    const state = quickCreateFormState(job, "PROD", WINTER);
    expect(state.jobType).toBe("marketScreen");
    expect(state.scheduleType).toBe("cron");
    expect(state.cronExpression).toBe("30 14 * * 1-5");
    expect(state.subDailyOptIn).toBe(false);
    expect(state.targetUniverse).toBe("NASDAQ100");
    expect(state.maxItems).toBe(100);
    expect(state.sector).toBe("Technology");
    expect(state.thesis).toBe("bullish");
    expect(state.riskProfile).toBe("balanced");
    expect(state.pushToSlack).toBe(true);
    expect(state.slackChannel).toBe("#options-alerts");
    expect(state.environment).toBe("PROD");
  });
});

describe("5895 one action creates each selected job through the one builder", () => {
  it("builds a valid create body per selected job (callback, cron, universe)", () => {
    for (const job of selectedJobs()) {
      const built = buildQuickCreateSubmission(job, "PROD", WINTER);
      expect(built).not.toHaveProperty("error");
      const body = (built as { requestBody: Record<string, any> }).requestBody;
      expect(body.scheduleType).toBe("cron");
      expect(body.cron).toBe("30 14 * * 1-5");
      expect(body).not.toHaveProperty("subDailyOptIn");
      expect(body.payload.universe).toBe("NASDAQ100");
      expect(validateScheduleCriteriaClient(body.callback, body.payload)).toBeNull();
    }
    const callbacks = selectedJobs().map(
      (job) =>
        (buildQuickCreateSubmission(job, "PROD", WINTER) as { requestBody: Record<string, any> })
          .requestBody.callback,
    );
    expect(callbacks).toEqual(["autonomousOptionsAnalysis", "autonomousMarketScreen"]);
  });

  it("refuses to build discovery: the blocked job never yields a body", () => {
    const discovery = quickCreateJobs(WINTER).find(
      (job) => job.formJob === "strategyDiscovery",
    )!;
    const built = buildQuickCreateSubmission(discovery, "PROD", WINTER);
    expect(built).toHaveProperty("error");
    expect((built as { error: string }).error).toMatch(/saved (discovery )?view/i);
  });

  it("posts one create per selected job, in plan order, and reports each id", async () => {
    const posted: Array<Record<string, any>> = [];
    const create = async (body: Record<string, any>) => {
      posted.push(body);
      return { success: true, schedule: { id: `sched-${posted.length}` } };
    };
    const results = await runQuickCreate(quickCreateJobs(WINTER), create, "PROD", WINTER);
    expect(posted).toHaveLength(2);
    expect(posted.map((b) => b.callback)).toEqual([
      "autonomousOptionsAnalysis",
      "autonomousMarketScreen",
    ]);
    expect(results).toEqual([
      { label: "Autonomous Options Analysis", ok: true, scheduleId: "sched-1" },
      { label: "Autonomous Market Screen (Stocks)", ok: true, scheduleId: "sched-2" },
    ]);
  });

  it("keeps going past a failed create and reports the failure per job", async () => {
    const create = async (body: Record<string, any>) => {
      if (body.callback === "autonomousOptionsAnalysis") {
        return { success: false, error: "Connect an E*TRADE account first." };
      }
      return { success: true, schedule: { id: "sched-market" } };
    };
    const results = await runQuickCreate(quickCreateJobs(WINTER), create, "PROD", WINTER);
    expect(results).toEqual([
      {
        label: "Autonomous Options Analysis",
        ok: false,
        error: "Connect an E*TRADE account first.",
      },
      { label: "Autonomous Market Screen (Stocks)", ok: true, scheduleId: "sched-market" },
    ]);
  });

  it("reports a throwing create per job instead of failing the batch", async () => {
    const create = async () => {
      throw new Error("network down");
    };
    const results = await runQuickCreate(quickCreateJobs(WINTER), create, "PROD", WINTER);
    expect(results).toHaveLength(2);
    expect(results.every((r) => r.ok === false && r.error === "network down")).toBe(true);
  });

  it("posts nothing when nothing is selected", async () => {
    const create = vi.fn(async () => ({ success: true, schedule: { id: "x" } }));
    const results = await runQuickCreate(
      quickCreateJobs(WINTER).map((job) => ({ ...job, selected: false })),
      create,
      "PROD",
      WINTER,
    );
    expect(create).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("never posts a blocked job, even if it is forced selected", async () => {
    const create = vi.fn(async () => ({ success: true, schedule: { id: "x" } }));
    const jobs = quickCreateJobs(WINTER).map((job) =>
      job.formJob === "strategyDiscovery" ? { ...job, selected: true } : job,
    );
    const results = await runQuickCreate(jobs, create, "PROD", WINTER);
    expect(create).toHaveBeenCalledTimes(2);
    expect(results.find((r) => r.label === "Saved-View Strategy Discovery")).toEqual({
      label: "Saved-View Strategy Discovery",
      ok: false,
      error: expect.stringMatching(/saved (discovery )?view/i),
    });
  });
});
