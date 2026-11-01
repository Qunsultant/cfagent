/**
 * Issue #2460 (Agent Mesh S19, programme #2225 G13c) — the RSI
 * proposal pipeline, the per-door cost budgets, and the
 * Skills-packaging assessment.
 *
 * Three claims are pinned here:
 *
 *  1. COST HONESTY. The registry carries exactly one cost-budget
 *     record per door. A record may name caps only where a real
 *     enforcing surface and a real accounting source exist (the
 *     PaymentsAgent BudgetGuard over mas_transactions, for the
 *     chat-turn and A2A spend facets — caps pinned against
 *     DEFAULT_BUDGET itself so the record cannot drift from the
 *     guard). Where cost is not measurable (agent-as-a-tool;
 *     the chat turn's model tokens), the record says so with a
 *     gap and NO numbers — a fabricated cap is a failed pin.
 *
 *  2. THE LOOP'S PROPOSE STAGE. A failing golden task in the
 *     S18 eval store whose evidence clears the bar (#1742
 *     discipline: a sample floor + a strict-majority failure
 *     rate + a live latest failure) becomes a filed §5 issue
 *     through the injectable filer seam, its body carrying the
 *     evidence refs and the falsification criterion. Evidence
 *     that does not clear the bar produces NO filing — the
 *     refusal itself is the recorded outcome. Filing is the
 *     pipeline's maximum reach: nothing here actuates.
 *
 *  3. SKILLS, ANSWERED NOT ADOPTED. The packaging assessment is
 *     recorded with a recommendation, consistent with S14's
 *     agent-skills family record — which stays ABSENT: this
 *     slice adopts nothing.
 */
import { describe, expect, it } from "vitest";
import { getTableName } from "drizzle-orm";
import {
  MESH_DOORS,
  MESH_DOOR_COST_BUDGETS,
  MESH_SKILLS_ASSESSMENT,
  MESH_TOOL_FAMILIES,
  doorCostBudget,
} from "../src/agents/registry";
import { DEFAULT_BUDGET } from "../src/payments/budget-guard";
import {
  MeshDoorBudgetError,
  chargeDoorBudget,
  createMeshDoorBudgetLedger,
} from "../src/services/meshDoorBudgets";
import {
  ALL_MIGRATIONS,
  MIGRATION_0025_AGENT_MESH_PROPOSALS,
  MIGRATION_0026_TENANT_AUTO_REFRESH,
  MIGRATION_0028_TENANT_PROVIDERS,
  MIGRATION_0029_PROOF_REDEMPTIONS,
  MIGRATION_0030_BILLING_CUSTOMERS,
  MIGRATION_0031_REFERRAL_ATTRIBUTION,
} from "../src/data/migrationRunner";
import { agentMeshProposals } from "../src/data/drizzleSchema";
import { InMemoryMeshProposalStore } from "../src/data/inMemoryMeshProposalAdapter";
import { meshProposalStoreForEnv } from "../src/data/createMeshProposalPorts";
import { D1MeshProposalAdapter } from "../src/data/d1MeshProposalAdapter";
import { InMemoryMeshEvalStore } from "../src/data/inMemoryMeshEvalAdapter";
import type { MeshEvalTaskResult } from "../src/data/meshEvalPorts";
import { InMemoryProposalLedgerAdapter } from "../src/data/inMemoryProposalLedgerAdapter";
import {
  MESH_PROPOSAL_MIN_RUNS,
  MeshProposalError,
  MeshProposalPipeline,
  buildProposalIssue,
  calibrationSignalFromVerdict,
  collectEvalSignals,
  evaluateEvidenceBar,
  type MeshEvidenceSignal,
  type MeshProposalFiler,
} from "../src/services/meshProposalPipeline";

/* ------------------------------------------------------------------ */
/* Per-door cost budgets — the registry record                         */
/* ------------------------------------------------------------------ */

describe("per-door cost budgets (registry)", () => {
  it("exactly one budget record per door, keyed to the door inventory", () => {
    expect(MESH_DOOR_COST_BUDGETS).toHaveLength(MESH_DOORS.length);
    expect(MESH_DOOR_COST_BUDGETS.map((r) => r.door).sort()).toEqual(
      MESH_DOORS.map((d) => d.id).sort(),
    );
    for (const door of MESH_DOORS) {
      expect(doorCostBudget(door.id).door).toBe(door.id);
    }
  });

  it("caps exist ONLY on enforced records, and the enforced caps ARE the BudgetGuard's", () => {
    for (const record of MESH_DOOR_COST_BUDGETS) {
      if (record.enforcement === "enforced") {
        expect(record.caps).not.toBeNull();
        expect(record.caps?.perCall).toBe(DEFAULT_BUDGET.perCallCapCents);
        expect(record.caps?.perDay).toBe(DEFAULT_BUDGET.dailyCapCents);
        expect(record.accountingSource).toBeTruthy();
        expect(record.enforcingSurface).toBeTruthy();
      } else {
        // No fabricated caps: a door nobody meters gets no numbers.
        expect(record.caps).toBeNull();
      }
    }
    // The two doors whose spend facet runs through PaymentsAgent.
    expect(doorCostBudget("chat-turn").enforcement).toBe("enforced");
    expect(doorCostBudget("a2a").enforcement).toBe("enforced");
  });

  it("the unmeasurable door records a gap and no accounting source", () => {
    const tool = doorCostBudget("agent-as-a-tool");
    expect(tool.enforcement).toBe("not-measurable");
    expect(tool.accountingSource).toBeNull();
    expect(tool.gaps.length).toBeGreaterThan(0);
    // The chat turn's token facet is a named gap even though its
    // spend facet is enforced — the record must not overclaim.
    const chat = doorCostBudget("chat-turn");
    expect(chat.gaps.join(" ")).toMatch(/token/i);
  });

  it("accounting-only doors name their source and carry no caps", () => {
    for (const id of ["http-routes", "mcp"] as const) {
      const record = doorCostBudget(id);
      expect(record.enforcement).toBe("accounting-only");
      expect(record.accountingSource).toBeTruthy();
      expect(record.caps).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ */
/* Per-door cost budgets — the guard (SubrequestBudget shape)          */
/* ------------------------------------------------------------------ */

describe("door budget guard", () => {
  it("the ledger mirrors SubrequestBudget: synchronous charge, exhausted flips at the cap", () => {
    const ledger = createMeshDoorBudgetLedger(3);
    expect(ledger.tryConsume()).toBe(true);
    expect(ledger.tryConsume(2)).toBe(true);
    expect(ledger.used).toBe(3);
    expect(ledger.exhausted).toBe(true);
    expect(ledger.tryConsume()).toBe(false);
    expect(ledger.used).toBe(3);
  });

  it("an enforced record refuses over-cap charges with the stable coded error", () => {
    const record = doorCostBudget("chat-turn");
    const ledger = createMeshDoorBudgetLedger(record.caps!.perDay!);
    const first = chargeDoorBudget(record, ledger, record.caps!.perDay! - 1);
    expect(first.charged).toBe(true);
    expect(first.enforced).toBe(true);
    let caught: unknown;
    try {
      chargeDoorBudget(record, ledger, 2);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeshDoorBudgetError);
    expect((caught as MeshDoorBudgetError).code).toBe("MESH_DOOR_BUDGET_EXCEEDED");
    expect((caught as MeshDoorBudgetError).door).toBe("chat-turn");
  });

  it("an enforced record charged without a ledger fails loud, never silently", () => {
    const record = doorCostBudget("a2a");
    expect(() => chargeDoorBudget(record, null, 1)).toThrowError(MeshDoorBudgetError);
  });

  it("an accounting-only record accumulates without refusing", () => {
    const record = doorCostBudget("http-routes");
    const ledger = createMeshDoorBudgetLedger(Number.POSITIVE_INFINITY);
    const verdict = chargeDoorBudget(record, ledger, 12345);
    expect(verdict.charged).toBe(true);
    expect(verdict.enforced).toBe(false);
    expect(ledger.used).toBe(12345);
  });

  it("a not-measurable record charges nothing and touches no ledger", () => {
    const record = doorCostBudget("agent-as-a-tool");
    const ledger = createMeshDoorBudgetLedger(10);
    const verdict = chargeDoorBudget(record, ledger, 5);
    expect(verdict.charged).toBe(false);
    expect(ledger.used).toBe(0);
  });

  it("a negative or non-finite cost is an invalid charge, not a silent no-op", () => {
    const record = doorCostBudget("http-routes");
    const ledger = createMeshDoorBudgetLedger(Number.POSITIVE_INFINITY);
    let caught: unknown;
    try {
      chargeDoorBudget(record, ledger, -1);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeshDoorBudgetError);
    expect((caught as MeshDoorBudgetError).code).toBe("MESH_DOOR_BUDGET_INVALID_COST");
  });
});

/* ------------------------------------------------------------------ */
/* Proposal store — port, adapters, migration                          */
/* ------------------------------------------------------------------ */

describe("mesh proposal store", () => {
  it("migration 0025 is registered and 0031 is last (#2657, after #2656), and the drizzle schema carries the table", () => {
    expect(MIGRATION_0025_AGENT_MESH_PROPOSALS.version).toBe(25);
    expect(MIGRATION_0025_AGENT_MESH_PROPOSALS.sql).toContain("agent_mesh_proposals");
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0025_AGENT_MESH_PROPOSALS);
    // #2481 appended migration 0026 (tenant auto-refresh) after 0025.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0026_TENANT_AUTO_REFRESH);
    // #2547 appended migration 0027 (price catalogue approval) after 0026.
    // Slice 1 of the provider/broker programme appends migration 0028
    // (tenant data-provider / broker columns) after 0027.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0028_TENANT_PROVIDERS);
    // #2548 appended migration 0029 (proof redemptions) after 0028.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0029_PROOF_REDEMPTIONS);
    // #2656 (Phase 2.1) appends migration 0030 (billing customers) after 0029.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0030_BILLING_CUSTOMERS);
    // #2657 (Phase 2.2) appends migration 0031 (referral attribution) after 0030.
    expect(ALL_MIGRATIONS).toContain(MIGRATION_0031_REFERRAL_ATTRIBUTION);
    expect(ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]).toBe(
      MIGRATION_0031_REFERRAL_ATTRIBUTION,
    );
    expect(getTableName(agentMeshProposals)).toBe("agent_mesh_proposals");
  });

  it("composition root: unbound env → in-memory store; AGENT_DB bound → D1 adapter; never throws", () => {
    expect(meshProposalStoreForEnv({})).toBeInstanceOf(InMemoryMeshProposalStore);
    expect(meshProposalStoreForEnv({ AGENT_DB: {} })).toBeInstanceOf(D1MeshProposalAdapter);
  });
});

/* ------------------------------------------------------------------ */
/* The evidence bar                                                    */
/* ------------------------------------------------------------------ */

function goldenSignal(overrides: Partial<MeshEvidenceSignal>): MeshEvidenceSignal {
  return {
    signalKey: "golden-task:chat-screen-run",
    kind: "golden-task",
    subject: "chat-screen-run",
    samples: 3,
    failures: 2,
    failureRate: 2 / 3,
    latestFailed: true,
    evidenceRefs: [],
    ...overrides,
  };
}

describe("evidence bar (#1742 discipline)", () => {
  it("a strict-majority failing golden task with enough runs clears the bar", () => {
    const verdict = evaluateEvidenceBar(goldenSignal({}));
    expect(verdict.passes).toBe(true);
    expect(verdict.reasons).toEqual([]);
  });

  it("below the run floor the bar refuses, however bad the failures", () => {
    const verdict = evaluateEvidenceBar(
      goldenSignal({ samples: MESH_PROPOSAL_MIN_RUNS - 1, failures: 2, failureRate: 1 }),
    );
    expect(verdict.passes).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/floor/);
  });

  it("a tie is noise, not a signal: rate exactly 0.5 refuses", () => {
    const verdict = evaluateEvidenceBar(
      goldenSignal({ samples: 4, failures: 2, failureRate: 0.5 }),
    );
    expect(verdict.passes).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/strict majority/);
  });

  it("a task whose latest run passed has no live failure to propose against", () => {
    const verdict = evaluateEvidenceBar(goldenSignal({ latestFailed: false }));
    expect(verdict.passes).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/latest/);
  });

  it("calibration signals use the #1742 floor itself (CALIBRATION_MIN_SAMPLE)", () => {
    const strong = calibrationSignalFromVerdict({
      agentKey: "orchestrator",
      thesis: "momentum",
      evaluated: 20,
      falsified: 13,
    });
    expect(strong.samples).toBe(20);
    expect(strong.failureRate).toBeCloseTo(13 / 20);
    expect(evaluateEvidenceBar(strong).passes).toBe(true);
    const thin = calibrationSignalFromVerdict({
      agentKey: "orchestrator",
      thesis: "momentum",
      evaluated: 19,
      falsified: 19,
    });
    expect(evaluateEvidenceBar(thin).passes).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The pipeline, end to end                                            */
/* ------------------------------------------------------------------ */

function evalResult(
  runId: string,
  taskId: string,
  passed: boolean,
  startedAtMs: number,
  failures: string[] = [],
  traceId?: string,
): MeshEvalTaskResult {
  return {
    runId,
    taskId,
    door: "chat-turn",
    className: "OrchestratorAgent",
    seq: 0,
    passed,
    outcome: passed ? "completed" : "refused",
    failures,
    traceId,
    facts: {},
    startedAtMs,
    durationMs: 5,
  };
}

const DRAFT = {
  title: "Golden task chat-screen-run fails its screen expectation",
  problem: "The chat screen golden task fails in a strict majority of recorded runs.",
  proposedChange: "Diagnose the chat screen path against the failing runs' traces and fix the root cause.",
  expectedEffect: "chat-screen-run returns to passing in the golden-task harness.",
  falsificationCriterion:
    "Falsified if chat-screen-run passes in the next 3 consecutive recorded harness runs without a change to the task's expectation.",
};

class FakeFiler implements MeshProposalFiler {
  readonly filed: { title: string; body: string; labels: string[] }[] = [];
  async file(issue: { title: string; body: string; labels: string[] }) {
    this.filed.push(issue);
    return { number: 9900 + this.filed.length, url: "https://example.invalid/issues/9901" };
  }
}

async function seedFailingTask(store: InMemoryMeshEvalStore) {
  await store.record(evalResult("run-1", "chat-screen-run", true, 1000));
  await store.record(
    evalResult("run-2", "chat-screen-run", false, 2000, ["facts.workflowStarts: expected 1, got 0"], "trace-aaa"),
  );
  await store.record(
    evalResult("run-3", "chat-screen-run", false, 3000, ["facts.workflowStarts: expected 1, got 0"], "trace-bbb"),
  );
}

describe("proposal pipeline", () => {
  it("collectEvalSignals aggregates the eval store through the port (no report scraping)", async () => {
    const evals = new InMemoryMeshEvalStore();
    await seedFailingTask(evals);
    const signals = await collectEvalSignals(evals, ["chat-screen-run"]);
    expect(signals).toHaveLength(1);
    const signal = signals[0];
    expect(signal.samples).toBe(3);
    expect(signal.failures).toBe(2);
    expect(signal.latestFailed).toBe(true);
    // Evidence refs reach the failing runs and their traces.
    const refs = signal.evidenceRefs.map((r) => r.ref);
    expect(refs).toContain("run-2");
    expect(refs).toContain("run-3");
    expect(signal.evidenceRefs.map((r) => r.detail.traceId)).toContain("trace-bbb");
  });

  it("a failing golden task becomes a FILED §5 proposal carrying its evidence", async () => {
    const evals = new InMemoryMeshEvalStore();
    await seedFailingTask(evals);
    const proposals = new InMemoryMeshProposalStore();
    const filer = new FakeFiler();
    const ledger = new InMemoryProposalLedgerAdapter();
    const pipeline = new MeshProposalPipeline({
      proposals,
      filer,
      ledger,
      now: () => 5000,
    });
    const [signal] = await collectEvalSignals(evals, ["chat-screen-run"]);
    const drafted = await pipeline.draft(signal, DRAFT);
    expect(drafted.state).toBe("drafted");
    const checked = await pipeline.checkEvidence(drafted.id, signal);
    expect(checked.state).toBe("evidence-checked");
    expect(checked.barVerdict?.passes).toBe(true);
    const filed = await pipeline.file(drafted.id);
    expect(filed.state).toBe("filed");
    expect(filed.filedIssueNumber).toBe(9901);
    expect(filer.filed).toHaveLength(1);
    const body = filer.filed[0].body;
    expect(body).toContain("## Agent");
    expect(body).toContain("#CAIO-quns");
    expect(body).toContain("chat-screen-run");
    expect(body).toContain("run-2");
    expect(body).toContain("run-3");
    expect(body).toContain("trace-bbb");
    expect(body).toContain("facts.workflowStarts: expected 1, got 0");
    expect(body).toContain(DRAFT.falsificationCriterion);
    // The filed proposal joins the foundation ledger's lifecycle.
    const bridged = await ledger.getProposal(drafted.id);
    expect(bridged?.state).toBe("proposed");
    // Filing is idempotent: a retry files nothing twice.
    const refiled = await pipeline.file(drafted.id);
    expect(refiled.state).toBe("filed");
    expect(filer.filed).toHaveLength(1);
  });

  it("an evidence-bar failure produces NO filing — the refusal is the record", async () => {
    const evals = new InMemoryMeshEvalStore();
    // One catastrophic run is an anecdote, not evidence.
    await evals.record(evalResult("run-1", "chat-screen-run", false, 1000, ["boom"]));
    const proposals = new InMemoryMeshProposalStore();
    const filer = new FakeFiler();
    const pipeline = new MeshProposalPipeline({ proposals, filer, now: () => 5000 });
    const [signal] = await collectEvalSignals(evals, ["chat-screen-run"]);
    const drafted = await pipeline.draft(signal, DRAFT);
    const checked = await pipeline.checkEvidence(drafted.id, signal);
    expect(checked.state).toBe("evidence-refused");
    expect(checked.barVerdict?.passes).toBe(false);
    expect(checked.barVerdict?.reasons.join(" ")).toMatch(/floor/);
    let caught: unknown;
    try {
      await pipeline.file(drafted.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeshProposalError);
    expect((caught as MeshProposalError).code).toBe("MESH_PROPOSAL_EVIDENCE_BAR");
    expect(filer.filed).toHaveLength(0);
  });

  it("a proposal without a falsification criterion cannot be drafted", async () => {
    const pipeline = new MeshProposalPipeline({
      proposals: new InMemoryMeshProposalStore(),
      now: () => 5000,
    });
    let caught: unknown;
    try {
      await pipeline.draft(goldenSignal({}), { ...DRAFT, falsificationCriterion: "  " });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeshProposalError);
    expect((caught as MeshProposalError).code).toBe("MESH_PROPOSAL_NO_FALSIFICATION");
  });

  it("an open proposal for the same signal is returned, never duplicated", async () => {
    const pipeline = new MeshProposalPipeline({
      proposals: new InMemoryMeshProposalStore(),
      now: () => 5000,
    });
    const signal = goldenSignal({});
    const first = await pipeline.draft(signal, DRAFT);
    const second = await pipeline.draft(signal, { ...DRAFT, title: "A duplicate draft" });
    expect(second.id).toBe(first.id);
    expect(second.title).toBe(DRAFT.title);
  });

  it("filing from the drafted state (bar never checked) is refused", async () => {
    const filer = new FakeFiler();
    const pipeline = new MeshProposalPipeline({
      proposals: new InMemoryMeshProposalStore(),
      filer,
      now: () => 5000,
    });
    const drafted = await pipeline.draft(goldenSignal({}), DRAFT);
    let caught: unknown;
    try {
      await pipeline.file(drafted.id);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(MeshProposalError);
    expect((caught as MeshProposalError).code).toBe("MESH_PROPOSAL_NOT_CHECKED");
    expect(filer.filed).toHaveLength(0);
  });

  it("the §5 body builder carries the lifecycle honestly (evidence + bar verdict)", async () => {
    const pipeline = new MeshProposalPipeline({
      proposals: new InMemoryMeshProposalStore(),
      now: () => 5000,
    });
    const signal = goldenSignal({
      evidenceRefs: [
        {
          kind: "golden-task",
          ref: "run-3",
          detail: { taskId: "chat-screen-run", traceId: "trace-bbb" },
        },
      ],
    });
    const drafted = await pipeline.draft(signal, DRAFT);
    const checked = await pipeline.checkEvidence(drafted.id, signal);
    const issue = buildProposalIssue(checked);
    expect(issue.title).toContain("[Enhancement]");
    expect(issue.labels).toContain("enhancement");
    expect(issue.body).toContain("## Evidence");
    expect(issue.body).toContain("## Falsification criterion");
  });
});

/* ------------------------------------------------------------------ */
/* Skills-packaging assessment                                         */
/* ------------------------------------------------------------------ */

describe("Skills-packaging assessment", () => {
  it("the assessment is recorded with a recommendation and its reasoning", () => {
    expect(MESH_SKILLS_ASSESSMENT.recommendation).toBe("adopt-as-packaging");
    expect(MESH_SKILLS_ASSESSMENT.adoptionState).toMatch(/deferred/);
    expect(MESH_SKILLS_ASSESSMENT.adoptionState).toMatch(/owner/);
    expect(MESH_SKILLS_ASSESSMENT.fits.length).toBeGreaterThan(0);
    expect(MESH_SKILLS_ASSESSMENT.doesNotFit.length).toBeGreaterThan(0);
    expect(MESH_SKILLS_ASSESSMENT.controlPoint).toMatch(/write-access/);
  });

  it("it is consistent with S14's record: the family stays ABSENT, nothing adopted", () => {
    const family = MESH_TOOL_FAMILIES.find((f) => f.id === "agent-skills");
    expect(family?.status).toBe("absent");
  });
});
