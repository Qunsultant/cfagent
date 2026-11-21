/**
 * Issue #5880 — one externalized job catalogue: the single unique job
 * list used by schedules, workflows and queues, reusing the ID
 * resolution work.
 *
 * The job universe today lives in five lists that disagree (the
 * create form's 3 hardcoded jobs, OPERATION_CATALOG's 21 operations,
 * the 9 seeded goals, the 9 schedule kinds, the worker-duty /
 * derived registries). This slice externalizes the ONE catalogue
 * (`config/job-catalogue.json`, #4253 precedent) and makes the
 * planner view, the create-form picker, the system-job maps and the
 * Schedules home kind classification read it.
 *
 * Pins:
 * - 5880-P01 the catalogue loads: 38 jobs, 12 planner agents, unique
 *   ids, one id per job, exactly one address (operation XOR callback
 *   with agent iff operation).
 * - 5880-P02 OPERATION_CATALOG is a view over the catalogue: the
 *   derived 12-agent / 21-operation literal is unchanged (the issue
 *   body says 22 operations; the file holds 21 — counted here).
 * - 5880-P03 the planner prompt and step validation still read the
 *   one list (all 21 operations plannable, unknown operations
 *   rejected).
 * - 5880-P04 the create-form picker reads the catalogue: exactly the
 *   3 form jobs, same values/labels/callbacks as before; every
 *   form-offered callback is API-creatable; SYSTEM_JOBS and
 *   TRIGGER_ROUTES derive to the same 3.
 * - 5880-P05 the Schedules home kind classification reads the
 *   catalogue: every catalogue callback classifies to its catalogue
 *   kind; delayed still wins as queued; unmatched stays other.
 * - 5880-P06 every seeded goal resolves to exactly one catalogue
 *   entry, with the goal's cron/timezone as the entry's default.
 * - 5880-P07 the catalogue ids resolve through the reused ID work:
 *   declaredTaskIdOf, record-id-is-list-id, callback, operation —
 *   one reader; provenance never distinguishes a duplicate.
 * - 5880-P08 the reader fails closed: duplicate ids/operations/
 *   callbacks, unknown kinds, operation without agent, callback with
 *   agent, bad cron, unknown timezone, orphan agent, and the override
 *   seam (invalid install throws, previous values stay).
 * - 5880-P09 census: every recorded callback (11), every creatable
 *   inventory callback, every derived record id and every Worker-cron
 *   duty resolves to exactly one catalogue entry.
 * - 5880-P10 no second hardcoded job list: the form modal carries no
 *   hardcoded job <option>, systemJobs.ts carries no hardcoded job
 *   map — both read the catalogue.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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
  validateJobCatalogue,
  jobCatalogueEntryForId,
  jobCatalogueEntryForCallback,
  jobCatalogueEntryForOperation,
  jobCatalogueEntryForFormJob,
  creatableJobCatalogueEntries,
  type JobCatalogueFile,
} from "../src/config/jobCatalogue";
import { OPERATION_CATALOG, plannerPrompt, validateSteps } from "../src/orchestrate";
import { classifyScheduleKind } from "../src/services/scheduleKinds";
import { jobCatalogueIdOf } from "../src/services/jobCatalogueResolution";
import { findDuplicateSchedule } from "../src/services/scheduleDedupe";
import { getBuiltinScheduledGoals } from "../src/config/builtinScheduledGoals";
import {
  JOB_CALLBACKS,
  SYSTEM_JOBS,
  TRIGGER_ROUTES,
} from "../src/client/scheduledOptionsManager/systemJobs";
import {
  CREATABLE_SCHEDULE_CALLBACKS,
  RECORDED_SCHEDULE_CALLBACKS,
} from "../src/agents/orchestrator/scheduleCallbacks";
import {
  CREATABLE_SCHEDULE_CALLBACKS_INVENTORY,
  WORKER_CRON_TRIGGERS_INVENTORY,
} from "../src/services/scheduleSystems";
import { DECLARED_TASK_CALLBACK } from "../src/services/unifiedScheduleManagement";

const here = dirname(fileURLToPath(import.meta.url));
const catalogueJson = JSON.parse(
  readFileSync(join(here, "..", "config/job-catalogue.json"), "utf8"),
) as JobCatalogueFile;
const modalSource = readFileSync(
  join(here, "..", "src/client/scheduledOptionsManager/ScheduleFormModal.tsx"),
  "utf8",
);
const systemJobsSource = readFileSync(
  join(here, "..", "src/client/scheduledOptionsManager/systemJobs.ts"),
  "utf8",
);

afterEach(() => {
  setJobCatalogue(null);
});

describe("5880-P01 the catalogue loads as one list", () => {
  it("holds 38 jobs and 12 planner agents, in file order", () => {
    expect(getJobCatalogue()).toHaveLength(38);
    expect(getJobCatalogueAgents()).toHaveLength(12);
    expect(getJobCatalogueAgents().map((a) => a.agent)).toEqual([
      "search",
      "payments",
      "tasks",
      "memory",
      "nlq",
      "qa",
      "trading",
      "scheduled",
      "social",
      "resource",
      "index",
      "autopilot",
    ]);
  });

  it("gives every job one stable unique id and one address", () => {
    const jobs = getJobCatalogue();
    const ids = new Set(jobs.map((j) => j.id));
    expect(ids.size).toBe(jobs.length);
    for (const job of jobs) {
      expect(job.id.trim()).toBe(job.id);
      expect(job.id.length).toBeGreaterThan(0);
      expect(job.label.trim().length).toBeGreaterThan(0);
      // One address: an operation job carries an agent, a callback
      // job carries a callback, never both, never neither.
      if (job.operation) {
        expect(job.agent).toBeTruthy();
        expect(job.callback).toBeUndefined();
      } else {
        expect(job.callback).toBeTruthy();
        expect(job.agent).toBeUndefined();
      }
    }
    const operations = jobs.filter((j) => j.operation).map((j) => j.operation as string);
    expect(new Set(operations).size).toBe(operations.length);
    const callbacks = jobs.filter((j) => j.callback).map((j) => j.callback as string);
    expect(new Set(callbacks).size).toBe(callbacks.length);
  });

  it("validates the file on disk", () => {
    const validated = validateJobCatalogue(catalogueJson);
    expect(validated.jobs).toHaveLength(38);
    expect(validated.agents).toHaveLength(12);
  });
});

describe("5880-P02 OPERATION_CATALOG is a view over the catalogue", () => {
  it("derives the same 12-agent / 21-operation literal", () => {
    expect(OPERATION_CATALOG).toEqual([
      {
        agent: "search",
        binding: "ORCHESTRATOR_AGENT",
        operations: ["search.query", "search.opportunity_hunt"],
        blurb: "Web and data search; the daily hunt scans the tradable universe.",
      },
      {
        agent: "payments",
        binding: "PAYMENTS_AGENT",
        operations: ["payments.draft"],
        blurb: "Draft a payment request (requires approval before execution).",
      },
      {
        agent: "tasks",
        binding: "TASKS_AGENT",
        operations: ["tasks.create"],
        blurb: "Create a tracked task with owner and due date.",
      },
      {
        agent: "memory",
        binding: "MEMORY_AGENT",
        operations: ["memory.remember"],
        blurb: "Store an outcome in long-term vector memory.",
      },
      {
        agent: "nlq",
        binding: "NLQ_AGENT",
        operations: ["nlq.execute"],
        blurb: "Execute a natural-language query against the data layer.",
      },
      {
        agent: "qa",
        binding: "ORCHESTRATOR_AGENT",
        operations: ["qa.supervised_fix", "qa.run_sweep"],
        blurb:
          "Investigate a QA failure and propose a supervised fix (issue #162); run the scheduled QA sweep (issue #1655).",
      },
      {
        agent: "trading",
        binding: "TRADING_AGENT",
        operations: [
          "trading.screen_stocks",
          "trading.screen_options",
          "trading.trade_stock",
          "trading.trade_options",
        ],
        blurb:
          "Provider-neutral trading competency (issue #291): stock/options screening and approval-gated trading across registered broker providers.",
      },
      {
        agent: "scheduled",
        binding: "SCHEDULED_AGENT",
        operations: ["chain.execute"],
        blurb:
          "A materialized approved chain goal (issue #1517): fired only through the governed predicate, executed by the chain lane.",
      },
      {
        agent: "social",
        binding: "SCHEDULED_AGENT",
        operations: ["social.publish", "pipeline:social-daily"],
        blurb:
          "Build the day's social drafts and publish them under the channel gating (issue #1077); pipeline:social-daily runs feed → generate → deliver as one scheduled firing (issue #1224).",
      },
      {
        agent: "resource",
        binding: "SCHEDULED_AGENT",
        operations: ["resource.rollup_daily", "resource.cap_alert", "resource.dashboard_comparison"],
        blurb:
          "SessionStore resource rollup, cap alert, and dashboard comparison (issue #1819): daily UTC rollup, hourly 70%-of-cap alert, and the instrumented-vs-dashboard comparison report, all as ScheduledAgent goals.",
      },
      {
        agent: "index",
        binding: "SCHEDULED_AGENT",
        operations: ["index.refresh_wikipedia", "index.refresh_holdings"],
        blurb:
          "Stored index-list refresh (issue #1980, follow-up to #1852; extended by #2962): weekly Wikipedia refresh of Dow / S&P 500 / S&P 100 / Nasdaq-100 / S&P 400 / the 11 GICS sectors and daily ETF-holdings refresh of Russell 2000 / Russell 1000 / Russell 3000, both as ScheduledAgent goals on the existing tick.",
      },
      {
        agent: "autopilot",
        binding: "SCHEDULED_AGENT",
        operations: ["autopilot.evaluate"],
        blurb:
          "Monthly Autopilot policy-envelope evaluation (issue #4411): a dry-run check of the live envelope against live limits and live account state, once a month, as a ScheduledAgent goal — never places orders.",
      },
    ]);
  });

  it("counts 21 operations, not the issue body's 22", () => {
    const total = OPERATION_CATALOG.reduce((n, e) => n + e.operations.length, 0);
    expect(total).toBe(21);
    expect(getJobCatalogue().filter((j) => j.operation)).toHaveLength(21);
  });
});

describe("5880-P03 the planner still reads the one list", () => {
  it("generates the prompt from all 21 operations", () => {
    const prompt = plannerPrompt("screen the market");
    for (const job of getJobCatalogue().filter((j) => j.operation)) {
      expect(prompt).toContain(job.operation as string);
    }
  });

  it("validates steps against the catalogue view", () => {
    expect(
      validateSteps([
        { id: "s1", agent: "trading", operation: "trading.screen_stocks", args: {} },
      ]),
    ).toHaveLength(1);
    expect(
      validateSteps([{ id: "s1", agent: "search", operation: "search.nope", args: {} }]),
    ).toBeNull();
  });
});

describe("5880-P04 the create-form picker reads the catalogue", () => {
  it("offers exactly the 3 form jobs, same values and labels as before", () => {
    const creatable = creatableJobCatalogueEntries();
    expect(creatable.map((j) => j.formJob)).toEqual([
      "optionsAnalysis",
      "marketScreen",
      "strategyDiscovery",
    ]);
    expect(creatable.map((j) => j.label)).toEqual([
      "Autonomous Options Analysis",
      "Autonomous Market Screen (Stocks)",
      "Saved-View Strategy Discovery",
    ]);
    expect(creatable.map((j) => j.callback)).toEqual([
      "autonomousOptionsAnalysis",
      "autonomousMarketScreen",
      "autonomousStrategyDiscovery",
    ]);
  });

  it("derives JOB_CALLBACKS, SYSTEM_JOBS and TRIGGER_ROUTES to the same values", () => {
    expect(JOB_CALLBACKS).toEqual({
      optionsAnalysis: "autonomousOptionsAnalysis",
      marketScreen: "autonomousMarketScreen",
      strategyDiscovery: "autonomousStrategyDiscovery",
    });
    expect(SYSTEM_JOBS).toEqual({
      autonomousMarketScreen: {
        label: "Stock Market Screen",
        description:
          "Screens the selected live stock universe with E*TRADE quotes and generates a PDF report.",
        triggerRoute: "/api/schedules/trigger-screen",
      },
      autonomousOptionsAnalysis: {
        label: "Options Market Screen",
        description:
          "Screens the selected live universe against E*TRADE option chains and generates a report.",
        triggerRoute: "/api/schedules/trigger-options-analysis",
      },
      autonomousStrategyDiscovery: {
        label: "Strategy Discovery",
        description:
          "Re-runs saved discovery views (symbol, thesis, target) captured from the discovery panel against the live E*TRADE chain and stores the ranked results.",
        triggerRoute: "/api/schedules/trigger-discovery",
      },
    });
    expect(TRIGGER_ROUTES).toEqual({
      autonomousOptionsAnalysis: "/api/schedules/trigger-options-analysis",
      autonomousMarketScreen: "/api/schedules/trigger-screen",
      autonomousStrategyDiscovery: "/api/schedules/trigger-discovery",
    });
  });

  it("offers only API-creatable callbacks", () => {
    for (const job of creatableJobCatalogueEntries()) {
      expect(CREATABLE_SCHEDULE_CALLBACKS).toContain(job.callback);
    }
    // The form-job keys are the CreatableJob union; each resolves back.
    for (const formJob of ["optionsAnalysis", "marketScreen", "strategyDiscovery"]) {
      expect(jobCatalogueEntryForFormJob(formJob)?.callback).toBe(
        JOB_CALLBACKS[formJob as keyof typeof JOB_CALLBACKS],
      );
    }
  });
});

describe("5880-P05 the Schedules home kind reads the catalogue", () => {
  it("classifies every catalogue callback to its catalogue kind", () => {
    for (const job of getJobCatalogue().filter((j) => j.callback)) {
      expect(classifyScheduleKind({ callback: job.callback })).toBe(job.kind);
    }
  });

  it("keeps the delayed-wins and unmatched-is-other rules", () => {
    expect(
      classifyScheduleKind({ callback: "autonomousOptionsAnalysis", type: "delayed" }),
    ).toBe("queued");
    expect(classifyScheduleKind({ callback: "no-such-callback" })).toBe("other");
    expect(classifyScheduleKind({ callback: "custom", payload: { universe: "sp500" } })).toBe(
      "stocks",
    );
  });
});

describe("5880-P06 every seeded goal resolves to one catalogue entry", () => {
  it("maps each builtin goal operation to its entry, with the goal cadence as default", () => {
    const goals = getBuiltinScheduledGoals();
    expect(goals).toHaveLength(9);
    for (const goal of goals) {
      const entry = jobCatalogueEntryForOperation(goal.operation);
      expect(entry).toBeDefined();
      expect(entry!.id).toBe(goal.operation);
      expect(entry!.defaultCron).toBe(goal.cron);
      expect(entry!.defaultTimeZone).toBe(goal.timeZone);
    }
  });
});

describe("5880-P07 ids resolve through the reused ID work", () => {
  it("resolves a declared Think task by its task id when it is a catalogue id", () => {
    expect(
      jobCatalogueIdOf({
        callback: DECLARED_TASK_CALLBACK,
        payload: { taskId: "nightly-research", scheduleHash: "h", scheduledFor: 1 },
      }),
    ).toBe("nightly-research");
  });

  it("resolves a callback, an operation and a record/list id to the same job", () => {
    expect(jobCatalogueIdOf({ callback: "autonomousMarketScreen", payload: {} })).toBe(
      "autonomousMarketScreen",
    );
    expect(
      jobCatalogueIdOf({ definition: { callback: "autoRenewETradeTokens", type: "cron" } }),
    ).toBe("token-renewal");
    expect(jobCatalogueIdOf({ operation: "search.opportunity_hunt" })).toBe(
      "search.opportunity_hunt",
    );
    expect(
      jobCatalogueIdOf({
        id: "sweep-stale-ledger-tasks",
        callback: "sweepStaleLedgerTasks",
        definition: { callback: "sweepStaleLedgerTasks", type: "cron" },
      }),
    ).toBe("sweep-stale-ledger-tasks");
    // A record's id IS the list id: the derived token-renewal record
    // resolves by its record id even with no callback on the value.
    expect(jobCatalogueIdOf({ id: "token-renewal" })).toBe("token-renewal");
  });

  it("returns null for a user Think task, an unknown callback and a bare id", () => {
    expect(
      jobCatalogueIdOf({
        callback: DECLARED_TASK_CALLBACK,
        payload: { taskId: "options-strategy-scan-observe", scheduleHash: "h", scheduledFor: 1 },
      }),
    ).toBeNull();
    expect(jobCatalogueIdOf({ callback: "no-such-callback" })).toBeNull();
    expect(jobCatalogueIdOf({ id: "sched-cron-1" })).toBeNull();
    expect(jobCatalogueIdOf(null)).toBeNull();
    expect(jobCatalogueIdOf(undefined)).toBeNull();
  });

  it("provenance never distinguishes a duplicate of the same catalogue job", () => {
    const armed = [
      {
        callback: "autonomousMarketScreen",
        payload: {
          universe: "SP500",
          provenance: { origin: "chat", creator: "u1", createdAt: "2026-11-20T00:00:00Z" },
        },
        cron: "0 7 * * *",
      },
    ];
    const fresh = {
      callback: "autonomousMarketScreen",
      payload: { universe: "SP500" },
      cron: "0 7 * * *",
    };
    expect(jobCatalogueIdOf(fresh)).toBe(jobCatalogueIdOf(armed[0]));
    expect(findDuplicateSchedule(armed as never, fresh.callback, fresh.payload, fresh)).toBe(
      armed[0],
    );
  });
});

describe("5880-P08 the reader fails closed", () => {
  function withJob(id: string, patch: Record<string, unknown>): JobCatalogueFile {
    const jobs = getJobCatalogue().map((j) => ({ ...j }));
    const target = jobs.find((j) => j.id === id);
    if (!target) throw new Error(`test helper: no catalogue job ${id}`);
    Object.assign(target, patch);
    return { version: 1, agents: getJobCatalogueAgents().map((a) => ({ ...a })), jobs };
  }

  it("rejects a duplicate id, a duplicate operation and a duplicate callback", () => {
    expect(() =>
      validateJobCatalogue(withJob("search.query", { id: "search.opportunity_hunt" })),
    ).toThrow(/duplicate id/);
    const dupOperation = withJob("search.opportunity_hunt", { operation: "search.query" });
    expect(() => validateJobCatalogue(dupOperation)).toThrow(/duplicate operation/);
    const dupCallback = withJob("autonomousGoalScreen", {
      callback: "autonomousMarketScreen",
    });
    expect(() => validateJobCatalogue(dupCallback)).toThrow(/duplicate callback/);
  });

  it("rejects an unknown kind, an operation without agent and a callback with agent", () => {
    expect(() => validateJobCatalogue(withJob("search.query", { kind: "nope" }))).toThrow(
      /unknown kind/,
    );
    expect(() => validateJobCatalogue(withJob("search.query", { agent: undefined }))).toThrow(
      /needs an agent/,
    );
    const callbackWithAgent = withJob("autonomousMarketScreen", { agent: "search" });
    expect(() => validateJobCatalogue(callbackWithAgent)).toThrow(/must not carry an agent/);
  });

  it("rejects a bad default cron, an unknown timezone and an orphan agent", () => {
    expect(() =>
      validateJobCatalogue(withJob("search.opportunity_hunt", { defaultCron: "0 */6 * *" })),
    ).toThrow(/invalid cron/);
    expect(() =>
      validateJobCatalogue(
        withJob("search.opportunity_hunt", { defaultTimeZone: "Mars/Olympus" }),
      ),
    ).toThrow(/unknown timeZone/);
    // The broker, when named, must be a registered BrokerId (or
    // "any") — the platform's broker registry is the authority, not
    // a second list in this reader.
    expect(() =>
      validateJobCatalogue(
        withJob("search.opportunity_hunt", { requiresBroker: true, broker: "no-such-broker" }),
      ),
    ).toThrow(/unknown broker/);
    const orphan = {
      version: 1,
      agents: [...getJobCatalogueAgents().map((a) => ({ ...a })), { agent: "orphan", binding: "ORCHESTRATOR_AGENT", blurb: "No jobs." }],
      jobs: getJobCatalogue().map((j) => ({ ...j })),
    };
    expect(() => validateJobCatalogue(orphan)).toThrow(/no operation job/);
  });

  it("rejects an empty list and a non-object", () => {
    expect(() => validateJobCatalogue({ version: 1, agents: [], jobs: [] })).toThrow();
    expect(() => validateJobCatalogue(null)).toThrow();
    expect(() => validateJobCatalogue("nope")).toThrow();
  });

  it("installs a valid override and restores the file values; an invalid override throws and keeps the current values", () => {
    const before = getJobCatalogue();
    const replacement: JobCatalogueFile = {
      version: 1,
      agents: [{ agent: "search", binding: "ORCHESTRATOR_AGENT", blurb: "Search." }],
      jobs: [
        {
          id: "search.query",
          label: "Web and data search",
          kind: "goal",
          agent: "search",
          operation: "search.query",
          source: "operation-catalog",
        },
      ],
    };
    setJobCatalogue(replacement);
    expect(getJobCatalogue()).toHaveLength(1);
    expect(() => setJobCatalogue(withJob("search.query", { kind: "nope" }))).toThrow(
      /unknown kind/,
    );
    expect(getJobCatalogue()).toHaveLength(1);
    setJobCatalogue(null);
    expect(getJobCatalogue()).toEqual(before);
  });
});

describe("5880-P09 census: every known job resolves to one entry", () => {
  it("resolves every recorded callback", () => {
    for (const callback of RECORDED_SCHEDULE_CALLBACKS) {
      expect(jobCatalogueEntryForCallback(callback)?.id).toBeTruthy();
    }
    expect(RECORDED_SCHEDULE_CALLBACKS).toHaveLength(11);
  });

  it("resolves every creatable inventory callback", () => {
    for (const callback of CREATABLE_SCHEDULE_CALLBACKS_INVENTORY) {
      expect(jobCatalogueEntryForCallback(callback)?.id).toBeTruthy();
    }
  });

  it("resolves every derived record id", () => {
    for (const id of [
      "token-renewal",
      "retention",
      "nightly-research",
      "iv-history-collection",
      "sweep-stale-ledger-tasks",
      "sweep-stale-async-jobs",
      "schedule-watchdog",
      "ticker-push",
    ]) {
      expect(jobCatalogueEntryForId(id)?.id).toBe(id);
    }
  });

  it("covers the Worker-cron duties by their dispatch crons", () => {
    expect(WORKER_CRON_TRIGGERS_INVENTORY).toEqual(["0 3 * * *", "*/30 * * * *", "0 4 * * *"]);
    expect(jobCatalogueEntryForId("token-renewal")?.defaultCron).toBe("0 3 * * *");
    expect(jobCatalogueEntryForId("retention")?.defaultCron).toBe("0 4 * * *");
    // The */30 tick is the alarm substrate, not a job: no entry claims it.
    expect(getJobCatalogue().filter((j) => j.defaultCron === "*/30 * * * *")).toHaveLength(0);
  });
});

describe("5880-P10 no second hardcoded job list", () => {
  it("the form modal renders its Job picker from the catalogue, not hardcoded options", () => {
    expect(modalSource).toContain("creatableJobCatalogueEntries");
    expect(modalSource).not.toContain('<option value="optionsAnalysis">');
    expect(modalSource).not.toContain('<option value="marketScreen">');
    expect(modalSource).not.toContain('<option value="strategyDiscovery">');
  });

  it("systemJobs.ts derives its maps from the catalogue, not literals", () => {
    expect(systemJobsSource).toContain("getJobCatalogue");
    expect(systemJobsSource).not.toContain("autonomousOptionsAnalysis: {");
    expect(systemJobsSource).not.toContain("JOB_CALLBACKS: Record<CreatableJob, string> = {");
  });
});
