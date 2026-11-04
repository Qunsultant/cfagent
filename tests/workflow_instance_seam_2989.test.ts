/**
 * Issue #2989 — the ONE seam for Cloudflare workflow instance starts.
 *
 * RED FIRST: the seam module does not exist yet. These tests pin the
 * unified create → adopt → fallback algorithm that replaces the three
 * hand-rolled variants (cfWorkflowAdapter.startWorkflowInstance,
 * sagaLegPort.startLeg, sagaEntry.startSagaViaBinding +
 * paymentWorkflowSubmission.startPaymentWorkflowViaBinding).
 *
 * The Cloudflare workflow id IS the instance id: binding.create()
 * returns only instance.id, instance.status() returns only
 * status/output/error, and get()/status() address the instance by
 * that id. There is no second runtime-exposed identifier, so the
 * seam persists the actual id used at start — derived or fallback —
 * and nothing else. (Deliberately NOT the aiSearchDispatch
 * correlationId: a per-dispatch randomUUID, unrelated to instances.)
 */
import { describe, expect, it } from "vitest";
import {
  resolveWorkflowRunId,
  startManagedWorkflowInstance,
  type ManagedWorkflowBinding,
} from "../src/workflows/workflowInstanceSeam";
import { WorkflowError } from "../src/workflows/workflowPorts";

type InstanceStub = {
  id: string;
  status: () => Promise<{ status: string; output?: unknown; error?: { message: string } }>;
};

class FakeBinding implements ManagedWorkflowBinding {
  creates: string[] = [];
  gets: string[] = [];
  private instances = new Map<string, string>();
  createBehavior?: (id: string) => Promise<{ id: string }>;
  getBehavior?: (id: string) => Promise<InstanceStub>;

  async create(options: { id: string; params: unknown }): Promise<{ id: string }> {
    this.creates.push(options.id);
    if (this.createBehavior) return this.createBehavior(options.id);
    this.instances.set(options.id, "running");
    return { id: options.id };
  }

  async get(id: string): Promise<InstanceStub> {
    this.gets.push(id);
    if (this.getBehavior) return this.getBehavior(id);
    if (!this.instances.has(id)) throw new Error("no such instance");
    return { id, status: async () => ({ status: "running" }) };
  }
}

describe("workflow instance seam (#2989)", () => {
  it("create success returns the ACTUAL returned id, not the requested one", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async () => ({ id: "host-assigned-id" });
    const res = await startManagedWorkflowInstance(binding, {
      id: "screen-requested",
      params: {},
    });
    expect(res.workflowId).toBe("host-assigned-id");
    expect(res.existing).toBe(false);
    expect(res.adoptedFallbackId).toBeUndefined();
  });

  it("create failure with a readable instance adopts it (same id, no second run)", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async () => {
      throw new Error("id already taken");
    };
    binding.getBehavior = async (id) => ({
      id,
      status: async () => ({ status: "running" }),
    });
    const res = await startManagedWorkflowInstance(binding, {
      id: "screen-abc",
      params: {},
    });
    expect(res).toMatchObject({ workflowId: "screen-abc", existing: true });
    expect(binding.creates).toEqual(["screen-abc"]);
    expect(binding.gets).toEqual(["screen-abc"]);
  });

  it("create + adopt failure falls back to the fallback id (lazy: factory runs only then)", async () => {
    const binding = new FakeBinding();
    let factoryCalls = 0;
    binding.createBehavior = async (id) => {
      if (id === "screen-abc") throw new Error("id unusable");
      return { id };
    };
    binding.getBehavior = async () => {
      throw new Error("no such instance");
    };
    const res = await startManagedWorkflowInstance(binding, {
      id: "screen-abc",
      fallbackId: () => {
        factoryCalls += 1;
        return "screen-fallbackhex";
      },
      params: {},
    });
    expect(res).toMatchObject({
      workflowId: "screen-fallbackhex",
      existing: false,
      adoptedFallbackId: true,
    });
    expect(factoryCalls).toBe(1);
    expect(binding.creates).toEqual(["screen-abc", "screen-fallbackhex"]);
  });

  it("fallback factory is NOT called on the happy path or the adopt path", async () => {
    const binding = new FakeBinding();
    let factoryCalls = 0;
    const fallbackId = () => {
      factoryCalls += 1;
      return "screen-fallbackhex";
    };
    await startManagedWorkflowInstance(binding, { id: "screen-ok", fallbackId, params: {} });
    binding.createBehavior = async () => {
      throw new Error("taken");
    };
    binding.getBehavior = async (id) => ({
      id,
      status: async () => ({ status: "running" }),
    });
    await startManagedWorkflowInstance(binding, { id: "screen-ok", fallbackId, params: {} });
    expect(factoryCalls).toBe(0);
  });

  it("fallback failure throws WorkflowError start_failed naming BOTH errors", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async () => {
      throw new Error("provider outage");
    };
    binding.getBehavior = async () => {
      throw new Error("no such instance");
    };
    await expect(
      startManagedWorkflowInstance(binding, {
        id: "screen-abc",
        fallbackId: () => "screen-fallbackhex",
        params: {},
      }),
    ).rejects.toMatchObject({ name: "WorkflowError", code: "start_failed" });
    await expect(
      startManagedWorkflowInstance(binding, {
        id: "screen-abc",
        fallbackId: () => "screen-fallbackhex",
        params: {},
      }),
    ).rejects.toThrow(/provider outage/);
  });

  it("without a fallback, adopt failure rethrows the ORIGINAL create error", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async () => {
      throw new Error("provider outage");
    };
    binding.getBehavior = async () => {
      throw new Error("no such instance");
    };
    await expect(
      startManagedWorkflowInstance(binding, { id: "saga-x", params: {} }),
    ).rejects.toThrow("provider outage");
    await expect(
      startManagedWorkflowInstance(binding, { id: "saga-x", params: {} }),
    ).rejects.not.toBeInstanceOf(WorkflowError);
  });

  it("a get result without a status function is NOT an adoption (payment-shaped binding)", async () => {
    const binding = new FakeBinding();
    binding.createBehavior = async () => {
      throw new Error("provider outage");
    };
    binding.getBehavior = async (id) => ({ id }) as InstanceStub;
    await expect(
      startManagedWorkflowInstance(binding, { id: "req-1", params: {} }),
    ).rejects.toThrow("provider outage");
  });
});

describe("workflow run-id resolution (#2989)", () => {
  it("a stored run id wins over the derived id; absent → derived", () => {
    expect(resolveWorkflowRunId("screen-fallbackhex", "screen-abc")).toBe("screen-fallbackhex");
    expect(resolveWorkflowRunId(undefined, "screen-abc")).toBe("screen-abc");
  });
});
