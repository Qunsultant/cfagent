/**
 * Delegation Contract preview (Qunsultant/cfagent#1773, item 4;
 * Microsoft HAX #1 scope disclosure, docs/agents/ux-architecture.md §7).
 *
 * Before a scheduled goal is created, the form must show what the
 * goal authorizes: what will be done, what will not be done, which
 * systems will be accessed, which actions still require approval,
 * budget and duration limits, and expected outputs.
 *
 * This builder is pure and states only what the form + the loaded
 * operation-catalog entry actually say. An unloaded catalog entry or
 * an unentered field renders as "not entered yet" / "not loaded yet"
 * — never as an invented system, budget, or authority. Creating the
 * goal authorizes its scheduled runs only: a live trade, payment, or
 * external publish the operation proposes still requires its own
 * approval surface before it moves.
 */

export interface DelegationContractInput {
  goalId: string;
  goalName: string;
  cron: string;
  operation: string;
  /** Catalog agent for the operation, when the operations list loaded. */
  operationAgent?: string;
  /** Catalog blurb for the operation, when the operations list loaded. */
  operationBlurb?: string;
  /** Goal budget in cents, as entered; null while the field is blank. */
  budgetCents: number | null;
  timeZone: string;
}

export interface DelegationContract {
  willDo: string[];
  willNotDo: string[];
  systemsAccessed: string[];
  approvalsRequired: string[];
  budgetAndDuration: string[];
  expectedOutputs: string[];
}

function shown(value: string, label: string): string {
  const trimmed = value.trim();
  return trimmed ? trimmed : `${label} not entered yet`;
}

export function formatBudgetCents(budgetCents: number | null): string {
  if (budgetCents === null || !Number.isFinite(budgetCents)) return "Budget not entered yet";
  return `Budget $${(budgetCents / 100).toFixed(2)} for the goal (as entered)`;
}

export function buildDelegationContract(input: DelegationContractInput): DelegationContract {
  const goalId = shown(input.goalId, "Goal id");
  const goalName = shown(input.goalName, "Goal name");
  const cron = shown(input.cron, "Schedule");
  const operation = shown(input.operation, "Operation");
  const timeZone = shown(input.timeZone, "Time zone");
  const operationKnown = input.operation.trim().length > 0;

  const willDo = [
    `Create scheduled goal "${goalName}" (id "${goalId}").`,
    `Run operation "${operation}" on schedule "${cron}" (${timeZone}).`,
  ];
  if (input.operationBlurb?.trim()) willDo.push(input.operationBlurb.trim());

  const willNotDo = operationKnown
    ? [
        `Run any operation other than "${operation}".`,
        "Change or remove any other goal.",
        "Run outside the cron schedule — a manual trigger is a separate action you take.",
      ]
    : [
        "Run any operation other than the one selected above.",
        "Change or remove any other goal.",
        "Run outside the cron schedule — a manual trigger is a separate action you take.",
      ];

  const systemsAccessed = operationKnown
    ? [
        input.operationAgent?.trim()
          ? `The "${input.operationAgent.trim()}" agent that implements "${operation}".`
          : `The agent that implements "${operation}" (catalog agent not loaded yet).`,
        "The schedule store holding this goal's record.",
      ]
    : ["The schedule store holding this goal's record (operation not entered yet)."];

  const approvalsRequired = [
    "Creating this goal authorizes its scheduled runs only.",
    "Any live trade, payment, or external publish the operation proposes still requires its own approval before it moves.",
  ];

  const budgetAndDuration = [
    formatBudgetCents(input.budgetCents),
    "Runs on its cron schedule until you disable or remove the goal; this form sets no end date.",
  ];

  const expectedOutputs = [
    "Job records for each tick, visible under Recent ticks.",
    input.operationBlurb?.trim()
      ? "The operation's own artifacts, as described in its catalog entry above."
      : "The operation's own outputs (see its catalog entry).",
  ];

  return { willDo, willNotDo, systemsAccessed, approvalsRequired, budgetAndDuration, expectedOutputs };
}
