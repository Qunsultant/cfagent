/**
 * Issue Qunsultant/cfagent#488 — schedule model unification questions (#457).
 *
 * #457 (closed 2026-10-21) answered the inventory questions as research,
 * but the confusion it documented never left the codebase: two schedule
 * systems with overlapping names still exist, and nothing in code said
 * so in one place. This module is that one place — the canonical
 * description of the three schedule systems, test-pinned to each of
 * their live sources (see tests/schedule-systems-488.test.ts) so drift
 * in any source fails a test instead of silently re-confusing them.
 *
 * NEVER-EITHER/OR compliance: this slice keeps BOTH schedule systems
 * behind their existing surfaces. It unifies the DESCRIPTION, not the
 * stores: no system is removed, no endpoint is removed, no creation
 * path is deleted. Merging the stores is a genuinely separate slice
 * and is carried below, not smuggled in here.
 *
 * The three systems, verified against current main:
 *  1. Orchestrator durable schedules — the Agents SDK durable schedule
 *     store inside the Orchestrator DO. These are the "schedules" of
 *     the Schedules panel and POST /api/schedules/create.
 *  2. ScheduledAgent goals — budget-checked agent operations evaluated
 *     on Worker cron ticks. These are the "goals" of the Scheduled
 *     goals UI and POST /api/schedule/goals. NOT the same store as (1).
 *  3. Worker cron triggers — platform triggers declared in
 *     wrangler.jsonc and dispatched by the Worker's scheduled() handler.
 *     These drive (2) and the nightly passes; they are not themselves
 *     user schedules.
 */

export interface ScheduleSystem {
  id: string;
  name: string;
  owner: string;
  storage: string;
  creation: string;
  execution: string;
}

export const SCHEDULE_SYSTEMS: ScheduleSystem[] = [
  {
    id: "orchestrator-durable-schedules",
    name: "Orchestrator durable schedules",
    owner: "OrchestratorAgent (src/agents/orchestrator.ts, scheduleMaintenance.ts, routes/schedules.ts)",
    storage: "Orchestrator Durable Object SQLite via the Agents SDK this.schedule API store",
    creation:
      "POST /api/schedules/create, gated to CREATABLE_SCHEDULE_CALLBACKS; baselines reconciled on agent start (removeUnownedBaselineSchedules)",
    execution: "The Durable Object wakes the agent callback directly at the scheduled time",
  },
  {
    id: "scheduled-agent-goals",
    name: "ScheduledAgent goals",
    owner: "ScheduledAgent (src/agents/scheduled-agent.ts, src/schedule.ts)",
    storage: "ScheduledAgent Durable Object SQL, key 'goals'; seeded from DEFAULT_SCHEDULES only when storage is empty",
    creation: "POST /api/schedule/goals (schedule dashboard API); the UI toggle and trigger endpoints share the same store",
    execution:
      "Worker */30 cron tick -> ScheduledAgent onCron -> budget-check via PaymentsAgent -> Orchestrator jobs (except social.publish, executed through the social goal executor)",
  },
  {
    id: "worker-cron-triggers",
    name: "Worker cron triggers",
    owner: "Worker entry (src/server.ts scheduled(), wrangler.jsonc crons)",
    storage: "None — platform trigger configuration, not a user schedule store",
    creation: "Editing wrangler.jsonc crons and deploying; a new trigger is an owner deployment action, not a user action",
    execution: "Cloudflare Cron Triggers invoke scheduled(event); the handler dispatches on event.cron",
  },
];

/** Mirrors CREATABLE_SCHEDULE_CALLBACKS in src/agents/orchestrator.ts (test-pinned). */
export const CREATABLE_SCHEDULE_CALLBACKS_INVENTORY = [
  "autonomousOptionsAnalysis",
  "autonomousMarketScreen",
  "autonomousStrategyDiscovery",
  "autonomousGoalScreen",
] as const;

/** Mirrors the ids of DEFAULT_SCHEDULES in src/schedule.ts (test-pinned). */
export const SCHEDULED_GOAL_IDS_INVENTORY = [
  "daily-qa-sweep",
  "opportunity-hunt",
  "daily-social-post",
  "resource-daily-rollup",
  "resource-cap-alert",
  "resource-dashboard-comparison",
] as const;

/** Mirrors the crons array in wrangler.jsonc (test-pinned). */
export const WORKER_CRON_TRIGGERS_INVENTORY = ["0 3 * * *", "*/30 * * * *", "0 4 * * *"] as const;

export interface ScheduleUnificationAnswer {
  question: string;
  answer: string;
  evidence: string;
}

export const SCHEDULE_UNIFICATION_ANSWERS: ScheduleUnificationAnswer[] = [
  {
    question: "How many schedule systems are there?",
    answer:
      "Three: Orchestrator durable schedules, ScheduledAgent goals, and Worker cron triggers. There is no single schedule store on current main.",
    evidence:
      "SCHEDULE_SYSTEMS in this module; wrangler.jsonc crons; src/agents/scheduled-agent.ts goals store; OrchestratorAgent this.schedule API store.",
  },
  {
    question: "Which component manages durable schedules?",
    answer:
      "OrchestratorAgent only. ScheduledAgent does not manage durable schedules — it holds goals, which are a different store evaluated on ticks.",
    evidence:
      "Issue #457 research (verified on main 2026-10-21); src/agents/orchestrator.ts route table vs src/agents/scheduled-agent.ts listGoals/addGoal.",
  },
  {
    question: "Are ScheduledAgent goals and Orchestrator durable schedules the same thing?",
    answer:
      "No. Different stores (ScheduledAgent DO SQL vs Orchestrator DO SQLite), different creation surfaces (/api/schedule/goals vs /api/schedules/create), and different execution (tick-evaluated, budget-checked job creation vs direct callback wake). Treating a goal id as a schedule id, or vice versa, is a category error.",
    evidence:
      "src/schedule.ts DEFAULT_SCHEDULES vs src/agents/orchestrator.ts CREATABLE_SCHEDULE_CALLBACKS; src/server.ts scheduled() */30 dispatch.",
  },
  {
    question: "What, if anything, unifies the two user-facing systems today?",
    answer:
      "Orchestrator jobs are the convergence point: a due goal creates an Orchestrator job, and a durable schedule runs inside the Orchestrator. The stores, creation APIs, and UIs remain separate; this module is the single canonical description of both, test-pinned to their sources.",
    evidence:
      "src/agents/scheduled-agent.ts onCron job creation; src/agents/orchestrator.ts scheduleMaintenance; this module's pinned inventories.",
  },
  {
    question: "Why is the daily options-research run not a fourth Worker cron trigger?",
    answer:
      "Deliberately: it rides the */30 tick via the research schedule guard instead of adding a trigger, per the free-plan ceiling note in wrangler.jsonc. Adding a trigger is a deployment decision, not a schedule-creation action.",
    evidence: "wrangler.jsonc crons comment; src/server.ts scheduled() research dispatch on the */30 tick.",
  },
];

export interface ScheduleUnificationCarried {
  question: string;
  owner: string;
  reason: string;
}

export const SCHEDULE_UNIFICATION_CARRIED: ScheduleUnificationCarried[] = [
  {
    question: "Rotating-thesis baseline scanner: keep, remove, or replace?",
    owner: "human owner",
    reason:
      "Carried from the #457 close comment: a product decision about the baseline set, not an engineering fact this slice can settle.",
  },
  {
    question: "Externalize the baseline set into config?",
    owner: "human owner",
    reason:
      "Carried from the #457 close comment: externalizing baselines changes deployment behavior and needs an owner direction on the config surface.",
  },
  {
    question: "Merge the durable-schedule store and the goals store into one schedule store?",
    owner: "human owner",
    reason:
      "Genuinely separate slice: it requires a store migration, a merged creation API, and a merged UI, and must keep both existing paths working behind a switch per NEVER-EITHER/OR. This slice documents the seam instead of merging it.",
  },
];

export function findScheduleSystem(id: string): ScheduleSystem | undefined {
  return SCHEDULE_SYSTEMS.find((system) => system.id === id);
}
