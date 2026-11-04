/**
 * Issue #2991 (#2770 Phase A) — leg registry: the closed saga leg
 * union (payment | screener | trade) becomes registry entries, and
 * the leg port is built from the registry with identical
 * start/adopt/fallback semantics to sagaLegPort. The registry
 * persists nothing: startLeg's returned workflowId (the ACTUAL id
 * used, derived or fallback) is the correlation carrier; persisting
 * it onto job records is #2989's seam, not this module's.
 *
 * Tests use fresh fakes — they do not copy the sagaLegPort tests.
 */
import { describe, expect, it } from "vitest";
import {
  createLegRegistry,
  legPortFromRegistry,
  type LegRegistryEntry,
} from "../src/workflows/legRegistry";
import {
  sagaLegInstanceId,
  type SagaLegBinding,
} from "../src/workflows/sagaLegPort";
import type { WorkflowBindingLike } from "../src/workflows/cfWorkflowAdapter";

function entry(over: Partial<LegRegistryEntry> = {}): LegRegistryEntry {
  return {
    id: "payment",
    bindingName: "PAYMENT_WORKFLOW",
    parameterSchema: ["runRequestId", "family"],
    stageContract: { observeStages: ["start", "poll"] },
    terminalSemantics: { complete: "SUCCESS" },
    deriveInstanceId: (sagaId: string) => sagaLegInstanceId(sagaId, "payment"),
    deriveFallbackId: (sagaId: string) =>
      `saga-h-fallback-${sagaId.replace(/[^A-Za-z0-9_-]/g, "-")}`,
    ...over,
  };
}

function fakeBinding(opts: {
  createIds?: string[];
  createThrowsFirst?: boolean;
  getStatus?: { status: string; output?: unknown; error?: { message: string } };
  getThrows?: boolean;
} = {}): WorkflowBindingLike & {
  creates: Array<{ id: string; params: unknown }>;
  gets: string[];
} {
  const creates: Array<{ id: string; params: unknown }> = [];
  const gets: string[] = [];
  let createCalls = 0;
  return {
    creates,
    gets,
    async create(options: { id: string; params: unknown }) {
      creates.push(options);
      createCalls += 1;
      if (opts.createThrowsFirst && createCalls === 1) {
        throw new Error("instance already exists");
      }
      return { id: options.id } as never;
    },
    async get(id: string) {
      gets.push(id);
      if (opts.getThrows) throw new Error("no such instance");
      return {
        status: async () => opts.getStatus ?? { status: "running" },
      } as never;
    },
  };
}

describe("leg registry #2991", () => {
  it("rejects a duplicate leg id", () => {
    expect(() => createLegRegistry([entry(), entry()])).toThrow(/payment/);
  });

  it("rejects an entry missing its instance-id derivation", () => {
    expect(() =>
      createLegRegistry([entry({ deriveInstanceId: undefined as never })]),
    ).toThrow(/deriveInstanceId/);
  });

  it("rejects an entry missing its fallback derivation", () => {
    expect(() =>
      createLegRegistry([entry({ deriveFallbackId: undefined as never })]),
    ).toThrow(/deriveFallbackId/);
  });

  it("startLeg creates under the derived id and returns the actual id", async () => {
    const binding = fakeBinding();
    const registry = createLegRegistry([entry()]);
    const port = legPortFromRegistry(
      registry,
      { PAYMENT_WORKFLOW: binding } as Partial<
        Record<SagaLegBinding, WorkflowBindingLike | undefined>
      >,
      "saga-1",
    );
    const result = await port.startLeg("payment", { runRequestId: "run-1" });
    expect(result).toEqual({
      workflowId: sagaLegInstanceId("saga-1", "payment"),
      existing: false,
    });
    expect(binding.creates[0].id).toBe(sagaLegInstanceId("saga-1", "payment"));
  });

  it("startLeg adopts an existing instance instead of duplicating", async () => {
    const binding = fakeBinding({
      createThrowsFirst: true,
      getStatus: { status: "running" },
    });
    const registry = createLegRegistry([entry()]);
    const port = legPortFromRegistry(
      registry,
      { PAYMENT_WORKFLOW: binding } as Partial<
        Record<SagaLegBinding, WorkflowBindingLike | undefined>
      >,
      "saga-1",
    );
    const result = await port.startLeg("payment", { runRequestId: "run-1" });
    expect(result).toEqual({
      workflowId: sagaLegInstanceId("saga-1", "payment"),
      existing: true,
    });
  });

  it("startLeg falls back to the hashed id when no instance is adoptable", async () => {
    const binding = fakeBinding({ createThrowsFirst: true, getThrows: true });
    const registry = createLegRegistry([entry()]);
    const port = legPortFromRegistry(
      registry,
      { PAYMENT_WORKFLOW: binding } as Partial<
        Record<SagaLegBinding, WorkflowBindingLike | undefined>
      >,
      "saga-1",
    );
    const result = await port.startLeg("payment", { runRequestId: "run-1" });
    expect(result.existing).toBe(false);
    expect(result.workflowId).toBe("saga-h-fallback-saga-1");
    expect(binding.creates[1].id).toBe("saga-h-fallback-saga-1");
  });

  it("startLeg throws loudly when the binding is absent", async () => {
    const registry = createLegRegistry([entry()]);
    const port = legPortFromRegistry(registry, {}, "saga-1");
    await expect(port.startLeg("payment", {})).rejects.toThrow(
      /PAYMENT_WORKFLOW is not configured/,
    );
  });

  it("startLeg throws loudly for an unregistered leg", async () => {
    const registry = createLegRegistry([entry()]);
    const port = legPortFromRegistry(
      registry,
      { PAYMENT_WORKFLOW: fakeBinding() } as Partial<
        Record<SagaLegBinding, WorkflowBindingLike | undefined>
      >,
      "saga-1",
    );
    await expect(port.startLeg("trade" as never, {})).rejects.toThrow(
      /not registered/,
    );
  });

  it("getLegStatus maps the binding status and returns null when absent", async () => {
    const binding = fakeBinding({
      getStatus: { status: "complete", output: { status: "settled" } },
    });
    const registry = createLegRegistry([entry()]);
    const port = legPortFromRegistry(
      registry,
      { PAYMENT_WORKFLOW: binding } as Partial<
        Record<SagaLegBinding, WorkflowBindingLike | undefined>
      >,
      "saga-1",
    );
    const status = await port.getLegStatus("payment", "pay-wf-1");
    expect(status?.status).toBe("complete");
    expect(status?.output).toEqual({ status: "settled" });
    const missing = fakeBinding({ getThrows: true });
    const port2 = legPortFromRegistry(
      registry,
      { PAYMENT_WORKFLOW: missing } as Partial<
        Record<SagaLegBinding, WorkflowBindingLike | undefined>
      >,
      "saga-1",
    );
    expect(await port2.getLegStatus("payment", "nope")).toBeNull();
  });

  it("derived ids stay under the 100-character ceiling (the #2129 lesson)", () => {
    const longSagaId = `saga-${"x".repeat(200)}`;
    const registry = createLegRegistry([entry()]);
    const e = registry.get("payment")!;
    expect(e.deriveInstanceId(longSagaId).length).toBeLessThanOrEqual(100);
    expect(e.deriveInstanceId(longSagaId)).toMatch(/^saga-h-[0-9a-f]{32}$/);
  });
});
