import { describe, it, expect } from "vitest";
import {
  createMemoryMembershipStore,
  createMembership,
} from "../src/security/authorization";
import type { MembershipStore } from "../src/security/authorization";
import { JOB_RUN_TRIGGERS } from "../src/data/jobRunRecordPorts";
import {
  narrowExecutionContext,
  parseExecutionContext,
  revalidateExecutionContext,
  resolveExecutionContext,
  serializeExecutionContext,
} from "../src/security/executionContext";
import type {
  ExecutionContext,
  ExecutionContextAuthority,
  ResolveExecutionContextInput,
} from "../src/security/executionContext";

/**
 * Issue #1078 — universal field list (Venus direction 2026-11-22):
 * the #1078 contract carries the full universal context — all ids
 * and both modes — so the one shared resolution (#6151) can produce
 * it verbatim with no second shape. The six new fields are optional
 * inputs validated when present, following the module's existing
 * optional-field pattern: malformed values deny fail-closed
 * (INVALID_FIELD); absence resolves. Dispatch mode reuses the one
 * trigger vocabulary (JOB_RUN_TRIGGERS, #5028/#3214 ruling); exec
 * mode is the #4136 axis (sync/async), separate from the trigger,
 * never conflated. Narrowing inherits every new field verbatim and
 * can never set or change one.
 */

const NOW = 1_800_000_000_000;

const ALL_MODES = JOB_RUN_TRIGGERS;

async function seedMember(
  store: MembershipStore,
  overrides: {
    internalUserId?: string;
    tenantId?: string;
    workspaceId?: string;
    role?: "member" | "tenant-admin" | "workspace-admin";
    scope?: "tenant" | "workspace";
  } = {},
): Promise<void> {
  const result = await createMembership(store, {
    internalUserId: overrides.internalUserId ?? "user-1",
    tenantId: overrides.tenantId ?? "tenant-a",
    workspaceId: overrides.workspaceId,
    roleBindings: [
      {
        role: overrides.role ?? "member",
        scope: overrides.scope ?? "tenant",
        workspaceId: overrides.workspaceId,
        grantedBy: "admin-1",
      },
    ],
    createdBy: "admin-1",
    nowMs: NOW,
  });
  if (!result.ok) throw new Error(result.error);
}

function authority(
  memberships: MembershipStore,
  bound: Set<string> = new Set(),
): ExecutionContextAuthority {
  return {
    memberships,
    async isConnectionBound(input) {
      return bound.has(
        `${input.tenantId}:${input.principalId}:${input.connectionId}`,
      );
    },
  };
}

function baseInput(
  overrides: Partial<ResolveExecutionContextInput> = {},
): ResolveExecutionContextInput {
  return {
    principalId: "user-1",
    tenantId: "tenant-a",
    taskId: "task-1",
    serviceId: "screener",
    environment: "sandbox",
    permission: "task:create",
    nowMs: NOW,
    ...overrides,
  };
}

async function resolvedContext(
  overrides: Partial<ResolveExecutionContextInput> = {},
): Promise<ExecutionContext> {
  const store = createMemoryMembershipStore();
  await seedMember(store);
  const result = await resolveExecutionContext(
    authority(store),
    baseInput(overrides),
  );
  if (!result.ok) throw new Error(`expected resolution, got ${result.code}`);
  return result.context;
}

const FULL_UNIVERSAL: Partial<ResolveExecutionContextInput> = {
  sessionId: "sess-1",
  runId: "run-1",
  platformId: "nextgentp",
  traceId: "trace-1",
  dispatchMode: "copilot",
  execMode: "async",
};

describe("universal fields on resolveExecutionContext", () => {
  it("resolves a context carrying all six new fields, frozen", async () => {
    const context = await resolvedContext(FULL_UNIVERSAL);
    expect(context.sessionId).toBe("sess-1");
    expect(context.runId).toBe("run-1");
    expect(context.platformId).toBe("nextgentp");
    expect(context.traceId).toBe("trace-1");
    expect(context.dispatchMode).toBe("copilot");
    expect(context.execMode).toBe("async");
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("resolves without any new field present (optional inputs)", async () => {
    const context = await resolvedContext();
    expect(context.sessionId).toBeUndefined();
    expect(context.runId).toBeUndefined();
    expect(context.platformId).toBeUndefined();
    expect(context.traceId).toBeUndefined();
    expect(context.dispatchMode).toBeUndefined();
    expect(context.execMode).toBeUndefined();
  });

  it.each(["sessionId", "runId", "platformId", "traceId"] as const)(
    "denies an empty %s with INVALID_FIELD",
    async (field) => {
      const store = createMemoryMembershipStore();
      await seedMember(store);
      const result = await resolveExecutionContext(
        authority(store),
        baseInput({ [field]: "   " }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe("INVALID_FIELD");
    },
  );

  it("denies an overlong session id with INVALID_FIELD", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({ sessionId: "s".repeat(513) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_FIELD");
  });

  it("trims whitespace on the new id fields", async () => {
    const context = await resolvedContext({
      sessionId: "  sess-1  ",
      runId: " run-1 ",
    });
    expect(context.sessionId).toBe("sess-1");
    expect(context.runId).toBe("run-1");
  });

  it("accepts each of the five dispatch modes", async () => {
    for (const mode of ALL_MODES) {
      const context = await resolvedContext({ dispatchMode: mode });
      expect(context.dispatchMode).toBe(mode);
    }
  });

  it("denies an unknown dispatch mode with INVALID_FIELD (never defaults)", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({
        dispatchMode: "banana" as ResolveExecutionContextInput["dispatchMode"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_FIELD");
  });

  it("accepts sync and async exec modes", async () => {
    const sync = await resolvedContext({ execMode: "sync" });
    expect(sync.execMode).toBe("sync");
    const asyncContext = await resolvedContext({ execMode: "async" });
    expect(asyncContext.execMode).toBe("async");
  });

  it("denies an unknown exec mode with INVALID_FIELD (never defaults)", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({
        execMode: "parallel" as ResolveExecutionContextInput["execMode"],
      }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe("INVALID_FIELD");
  });

  it("echoes the new fields on a denial so the decision stays auditable", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const result = await resolveExecutionContext(
      authority(store),
      baseInput({
        ...FULL_UNIVERSAL,
        dispatchMode: "banana" as ResolveExecutionContextInput["dispatchMode"],
      }),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("INVALID_FIELD");
    expect(result.request.sessionId).toBe("sess-1");
    expect(result.request.runId).toBe("run-1");
    expect(result.request.platformId).toBe("nextgentp");
    expect(result.request.traceId).toBe("trace-1");
    expect(result.request.dispatchMode).toBe("banana");
    expect(result.request.execMode).toBe("async");
  });
});

describe("universal fields on narrowExecutionContext", () => {
  it("inherits every new field verbatim into the child", async () => {
    const parent = await resolvedContext(FULL_UNIVERSAL);
    const child = narrowExecutionContext(parent, { agentRunId: "agent-1" });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.context.sessionId).toBe("sess-1");
    expect(child.context.runId).toBe("run-1");
    expect(child.context.platformId).toBe("nextgentp");
    expect(child.context.traceId).toBe("trace-1");
    expect(child.context.dispatchMode).toBe("copilot");
    expect(child.context.execMode).toBe("async");
  });
});

describe("universal fields on parseExecutionContext", () => {
  it("round-trips a context carrying all six new fields", async () => {
    const context = await resolvedContext(FULL_UNIVERSAL);
    const parsed = parseExecutionContext(serializeExecutionContext(context));
    expect(parsed).toEqual(context);
  });

  it("rejects a serialized context with an unknown dispatch mode", () => {
    const context = {
      tenantId: "tenant-a",
      principalId: "user-1",
      principalType: "human",
      initiatingPrincipalId: "user-1",
      taskId: "task-1",
      serviceId: "screener",
      environment: "sandbox",
      policyVersion: "v1",
      correlationId: "corr-1",
      dispatchMode: "banana",
    };
    expect(parseExecutionContext(JSON.stringify(context))).toBeNull();
  });

  it("rejects a serialized context with an unknown exec mode", () => {
    const context = {
      tenantId: "tenant-a",
      principalId: "user-1",
      principalType: "human",
      initiatingPrincipalId: "user-1",
      taskId: "task-1",
      serviceId: "screener",
      environment: "sandbox",
      policyVersion: "v1",
      correlationId: "corr-1",
      execMode: "parallel",
    };
    expect(parseExecutionContext(JSON.stringify(context))).toBeNull();
  });

  it("rejects a serialized context with an empty session id", () => {
    const context = {
      tenantId: "tenant-a",
      principalId: "user-1",
      principalType: "human",
      initiatingPrincipalId: "user-1",
      taskId: "task-1",
      serviceId: "screener",
      environment: "sandbox",
      policyVersion: "v1",
      correlationId: "corr-1",
      sessionId: "   ",
    };
    expect(parseExecutionContext(JSON.stringify(context))).toBeNull();
  });
});

describe("reference path carries the universal fields", () => {
  it("resolves, crosses the boundary, revalidates, and narrows with all six fields intact", async () => {
    const store = createMemoryMembershipStore();
    await seedMember(store);
    const auth = authority(store);
    const resolved = await resolveExecutionContext(
      auth,
      baseInput({ ...FULL_UNIVERSAL, correlationId: "corr-universal" }),
    );
    if (!resolved.ok) throw new Error("resolution failed");
    const carried = parseExecutionContext(
      serializeExecutionContext(resolved.context),
    );
    if (!carried) throw new Error("context did not survive the boundary");
    expect(carried).toEqual(resolved.context);
    const revalidated = await revalidateExecutionContext(
      auth,
      carried,
      "task:create",
      NOW,
    );
    expect(revalidated.ok).toBe(true);
    const child = narrowExecutionContext(carried, {
      agentRunId: "agent-1",
      delegationId: "delegation-1",
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.context.sessionId).toBe("sess-1");
    expect(child.context.runId).toBe("run-1");
    expect(child.context.platformId).toBe("nextgentp");
    expect(child.context.traceId).toBe("trace-1");
    expect(child.context.dispatchMode).toBe("copilot");
    expect(child.context.execMode).toBe("async");
    expect(child.context.correlationId).toBe("corr-universal");
  });
});
