/**
 * Issue #4435 (N7) — paid chat screen receipt email, supplied in
 * the chat turn.
 *
 * - Tool schema (meshDoorCommands.ts): run_stock_screen accepts
 *   an optional receiptEmail; the description tells the agent to
 *   ask the user for it in the chat turn when monetization is on
 *   and no receipt email is known, instead of calling without it.
 * - Door (meshScreenDoor.ts): the paid path resolves the receipt
 *   email as tool-call receiptEmail first, then the composed
 *   checkoutEmail seam. A supplied address that is not a
 *   well-formed email refuses coded before any start; with no
 *   address at all the door refuses coded checkout_email_required
 *   naming the missing contact and the action (reply with the
 *   receipt email address). The run record names the source
 *   (receiptEmailSource "in-turn" | "seam") on the result and
 *   in the MCP audit; the address itself rides the
 *   PaymentWorkflow submission (the run's durable record).
 * - NLQ port (nlqPorts.ts): takes no in-turn address — the
 *   in-turn source rides the mesh door's tool call — so its only
 *   source is the composed seam; its refusal carries
 *   [checkout_email_required] in the message text (the wire
 *   carries only the message) and names the same action.
 *
 * Deliberately NOT covered here: a slot-filling mechanism for
 * the deterministic NLQ executor (no pending-question state
 * exists there — the ask-flow lives on the MCP door, the
 * Copilot path); any change to the monetization gate or the
 * paid seam itself (#2373); the async dispatch leg (#5921).
 */
import { describe, expect, it } from "vitest";
import { MeshDoorError } from "../src/agents/orchestrator/meshDoors";
import {
  runStockScreenViaDoor,
  type MeshScreenDoorContext,
} from "../src/agents/orchestrator/meshScreenDoor";
import {
  nlqStockScreenPort,
  type NlqPortsContext,
} from "../src/agents/orchestrator/nlqPorts";
import { RunStockScreenCommand } from "../src/mcps/openaimp/meshDoorCommands";
import { isValidEmailFormat } from "../src/security/webhookReplay";
import { workflowTenantId } from "../src/workflows/screenerWorkflowRoutes";
import type { Env } from "../src/types";
import type { WorkflowJobCommand, WorkflowPort } from "../src/workflows/workflowPorts";
import type { PaymentWorkflowEventParams } from "../src/workflows/paymentWorkflow";
import type { CommercialStore } from "../src/data/commercialPorts";
import type { SubscriptionStore } from "../src/data/subscriptionPorts";
import type { PaidScreenStorePorts } from "../src/services/paidScreenSubmission";
import { MockSqlStorage } from "./mock-sql";

const LOGIN = "alice";
const IN_TURN_EMAIL = "alice+receipt@example.com";
const SEAM_EMAIL = "seam@example.com";
const STOCK_PRICE_USD = 0.02;
const TENANT = workflowTenantId({} as Env);

function failedCollationRows(chainId: string) {
  return [
    {
      jobKey: chainId,
      resultJson: JSON.stringify({
        jobId: chainId,
        workflowId: `screen-${chainId}`,
        lifecycle: "Failed",
        qualified: false,
        coverage: { evaluated: 0, considered: 0, ratio: null },
        shards: [],
        lifecycleTransitions: [],
        stageTransitions: [],
        reportKeys: [],
        storedShards: [],
        deliveredShards: [],
        error: "test collation",
      }),
    } as never,
  ];
}

function subscribedStores(): PaidScreenStorePorts {
  const commercial = {
    getAccount: async (userId: string) => ({
      id: userId,
      tenantId: TENANT,
      tier: "Subscribed" as const,
      tierSource: "operator" as const,
      creditsUSD: 0,
      includedRuns: 1,
      updatedAtMs: Date.now(),
    }),
  } as unknown as CommercialStore;
  const subscriptions = {
    listSubscriptions: async () => [],
  } as unknown as SubscriptionStore;
  return { commercial, subscriptions };
}

interface PaidDoorHarness {
  ctx: MeshScreenDoorContext;
  started: WorkflowJobCommand[];
  budgetCalls: Array<{ operation: string; amountCents: number }>;
  paymentCreates: Array<{ id: string; params: PaymentWorkflowEventParams }>;
}

function makePaidDoorHarness(opts: {
  monetizationOn?: boolean;
  seamEmail?: string | null;
  budgetVerdict?: { allowed: boolean; reason?: string };
} = {}): PaidDoorHarness {
  const sql = new MockSqlStorage();
  const started: WorkflowJobCommand[] = [];
  const budgetCalls: PaidDoorHarness["budgetCalls"] = [];
  const paymentCreates: PaidDoorHarness["paymentCreates"] = [];
  const port: WorkflowPort = {
    start: async (command) => {
      started.push(command);
      return {
        workflowId: `screen-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        existing: false,
        statusUrl: `/api/jobs/history?chainId=${encodeURIComponent(command.jobId)}`,
      };
    },
    status: async () => ({ status: "complete" }),
  };
  const paymentBinding = {
    create: async ({ id, params }: { id: string; params: PaymentWorkflowEventParams }) => {
      paymentCreates.push({ id, params: { ...params, account: { ...params.account } } });
      return { id };
    },
    get: async (_id: string) => ({ sendEvent: async () => {} }),
  };
  const ctx: MeshScreenDoorContext = {
    env: {} as MeshScreenDoorContext["env"],
    ensureTables: () => sql as never,
    workflowPort: port,
    readWorkflowJobHistory: async (_tenantId, chainId) => failedCollationRows(chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 5_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    monetizationOn: async () => opts.monetizationOn ?? true,
    paidScreenPriceUSD: async () => STOCK_PRICE_USD,
    paidBudgetCheck: async (_actingLogin, input) => {
      budgetCalls.push(input);
      return opts.budgetVerdict ?? { allowed: true };
    },
    checkoutEmail: () => (opts.seamEmail === undefined ? null : opts.seamEmail),
    paidScreenStores: subscribedStores(),
    paymentWorkflowBinding: paymentBinding as never,
    paymentWorkflowStatus: async () => null,
  };
  return { ctx, started, budgetCalls, paymentCreates };
}

interface NlqHarness {
  ctx: NlqPortsContext;
  paymentCreates: Array<{ id: string; params: PaymentWorkflowEventParams }>;
}

function makeNlqHarness(opts: { seamEmail?: string | null } = {}): NlqHarness {
  const sql = new MockSqlStorage();
  const paymentCreates: NlqHarness["paymentCreates"] = [];
  const paymentBinding = {
    create: async ({ id, params }: { id: string; params: PaymentWorkflowEventParams }) => {
      paymentCreates.push({ id, params: { ...params, account: { ...params.account } } });
      return { id };
    },
    get: async (_id: string) => ({ sendEvent: async () => {} }),
  };
  const ctx: NlqPortsContext = {
    schedule: async () => ({}),
    scheduleEvery: async () => ({}),
    cancelSchedule: async () => true,
    listSchedules: async () => [],
    getScreenerAgent: () => {
      throw new Error("direct ScreenerAgent fallback must not run on the paid path");
    },
    getSocialBriefStore: () => null,
    env: {} as NlqPortsContext["env"],
    ensureTables: () => sql as never,
    workflowPort: {
      start: async (command) => ({
        workflowId: `screen-${command.jobId}`,
        jobId: command.jobId,
        status: "running",
        existing: false,
        statusUrl: "",
      }),
      status: async () => ({ status: "complete" }),
    },
    readWorkflowJobHistory: async (_tenantId, chainId) => failedCollationRows(chainId),
    workflowPollIntervalMs: 1,
    workflowAwaitDeadlineMs: 5_000,
    sleep: async () => {},
    nowMs: () => Date.now(),
    monetizationOn: async () => true,
    paidScreenPriceUSD: async () => STOCK_PRICE_USD,
    paidBudgetCheck: async () => ({ allowed: true }),
    checkoutEmail: () => (opts.seamEmail === undefined ? null : opts.seamEmail),
    paidScreenStores: subscribedStores(),
    paymentWorkflowBinding: paymentBinding as never,
    paymentWorkflowStatus: async () => null,
  };
  return { ctx, paymentCreates };
}

describe("issue #4435 — run_stock_screen schema (receiptEmail)", () => {
  const command = new RunStockScreenCommand();

  it("accepts receiptEmail alongside universe and filters", () => {
    const parsed = command.zodSchema.parse({
      universe: "NASDAQ100",
      receiptEmail: IN_TURN_EMAIL,
    });
    expect(parsed.receiptEmail).toBe(IN_TURN_EMAIL);
  });

  it("exposes receiptEmail on the JSON schema and tells the agent to ask for it", () => {
    const props = (command.jsonSchema as { properties: Record<string, { description?: string }> })
      .properties;
    expect(Object.keys(props)).toContain("receiptEmail");
    expect(props.receiptEmail.description).toMatch(/ask the user for it/);
    expect(command.description).toMatch(/ask the user for it in the chat turn/);
  });

  it("refuses a blank receiptEmail at the schema", () => {
    expect(() => command.zodSchema.parse({ receiptEmail: "" })).toThrow();
    expect(() => command.zodSchema.parse({ receiptEmail: "   " })).toThrow();
  });
});

describe("issue #4435 — mesh door paid path (in-turn receipt email)", () => {
  it("starts the paid run with the in-turn email and stamps source in-turn", async () => {
    const h = makePaidDoorHarness({ seamEmail: null });
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {
      universe: "NASDAQ100",
      receiptEmail: IN_TURN_EMAIL,
    });
    expect(h.budgetCalls).toEqual([{ operation: "nlq.execute", amountCents: 2 }]);
    expect(h.paymentCreates).toHaveLength(1);
    expect(h.paymentCreates[0].params.email).toBe(IN_TURN_EMAIL);
    expect(h.paymentCreates[0].params.account).toMatchObject({
      userId: LOGIN,
      email: IN_TURN_EMAIL,
    });
    expect(result.receiptEmailSource).toBe("in-turn");
  });

  it("uses the composed seam when no in-turn email is supplied, stamped seam", async () => {
    const h = makePaidDoorHarness({ seamEmail: SEAM_EMAIL });
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, { universe: "NASDAQ100" });
    expect(h.paymentCreates).toHaveLength(1);
    expect(h.paymentCreates[0].params.email).toBe(SEAM_EMAIL);
    expect(result.receiptEmailSource).toBe("seam");
  });

  it("the in-turn email wins over the composed seam", async () => {
    const h = makePaidDoorHarness({ seamEmail: SEAM_EMAIL });
    const result = await runStockScreenViaDoor(h.ctx, LOGIN, {
      universe: "NASDAQ100",
      receiptEmail: IN_TURN_EMAIL,
    });
    expect(h.paymentCreates).toHaveLength(1);
    expect(h.paymentCreates[0].params.email).toBe(IN_TURN_EMAIL);
    expect(result.receiptEmailSource).toBe("in-turn");
  });

  it("refuses a malformed in-turn email coded — zero payment starts", async () => {
    const h = makePaidDoorHarness({ seamEmail: SEAM_EMAIL });
    const err = await runStockScreenViaDoor(h.ctx, LOGIN, {
      universe: "NASDAQ100",
      receiptEmail: "not-an-email",
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MeshDoorError);
    expect((err as MeshDoorError).code).toBe("checkout_email_required");
    expect((err as MeshDoorError).message).toMatch(/well-formed/);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });

  it("refuses with the action when no email is supplied anywhere — zero starts", async () => {
    const h = makePaidDoorHarness({ seamEmail: null });
    const err = await runStockScreenViaDoor(h.ctx, LOGIN, { universe: "NASDAQ100" }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MeshDoorError);
    expect((err as MeshDoorError).code).toBe("checkout_email_required");
    expect((err as MeshDoorError).message).toMatch(/reply with the receipt email address/);
    expect((err as MeshDoorError).message).toMatch(/No workflow was started/);
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.started).toHaveLength(0);
  });

  it("a blank in-turn email is treated as missing, not as an address", async () => {
    const h = makePaidDoorHarness({ seamEmail: null });
    await expect(
      runStockScreenViaDoor(h.ctx, LOGIN, { universe: "NASDAQ100", receiptEmail: "   " }),
    ).rejects.toMatchObject({ code: "checkout_email_required" });
    expect(h.paymentCreates).toHaveLength(0);
  });

  it("a free run ignores receiptEmail — no payment start", async () => {
    const h = makePaidDoorHarness({ monetizationOn: false, seamEmail: null });
    await runStockScreenViaDoor(h.ctx, LOGIN, {
      universe: "NASDAQ100",
      receiptEmail: IN_TURN_EMAIL,
    });
    expect(h.paymentCreates).toHaveLength(0);
    expect(h.started).toHaveLength(1);
  });
});

describe("issue #4435 — NLQ port paid path (seam only, coded refusal)", () => {
  it("starts the paid run with the seam email and stamps source seam", async () => {
    const h = makeNlqHarness({ seamEmail: SEAM_EMAIL });
    const port = nlqStockScreenPort(h.ctx);
    const result = await port.runScreen({
      filters: { universe: "NASDAQ100" } as never,
      userLogin: LOGIN,
    });
    expect(h.paymentCreates).toHaveLength(1);
    expect(h.paymentCreates[0].params.email).toBe(SEAM_EMAIL);
    expect(result.receiptEmailSource).toBe("seam");
  });

  it("refuses coded with the action when no email is resolvable — zero starts", async () => {
    const h = makeNlqHarness({ seamEmail: null });
    const port = nlqStockScreenPort(h.ctx);
    const err = await port
      .runScreen({ filters: { universe: "NASDAQ100" } as never, userLogin: LOGIN })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("[checkout_email_required]");
    expect((err as Error).message).toMatch(/reply with the receipt email address/);
    expect((err as Error).message).toMatch(/No workflow was started/);
    expect(h.paymentCreates).toHaveLength(0);
  });

  it("refuses a malformed seam email coded — zero starts", async () => {
    const h = makeNlqHarness({ seamEmail: "not-an-email" });
    const port = nlqStockScreenPort(h.ctx);
    await expect(
      port.runScreen({ filters: { universe: "NASDAQ100" } as never, userLogin: LOGIN }),
    ).rejects.toThrow(/well-formed/);
    expect(h.paymentCreates).toHaveLength(0);
  });
});

describe("issue #4435 — isValidEmailFormat (format-only, no allowlist)", () => {
  it("accepts well-formed addresses and rejects malformed ones", () => {
    expect(isValidEmailFormat("alice@example.com")).toBe(true);
    expect(isValidEmailFormat("alice+receipt@example.co.uk")).toBe(true);
    expect(isValidEmailFormat("  alice@example.com  ")).toBe(true);
    expect(isValidEmailFormat("not-an-email")).toBe(false);
    expect(isValidEmailFormat("alice@")).toBe(false);
    expect(isValidEmailFormat("alice@example")).toBe(false);
    expect(isValidEmailFormat("")).toBe(false);
  });
});
