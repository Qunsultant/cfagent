/**
 * Issue #1780 (Adapter S6, program #1717) — the one ApprovalWorkflow
 * port (start/decide) with the Cloudflare Workflows implementation
 * behind it.
 *
 * TDD Red first: this file failed before the implementation with
 * `Cannot find module '../src/services/approvalWorkflowPorts'`
 * (and the Cloudflare adapter module), then went green.
 *
 * Pins:
 * - The port's start passes the binding name + params verbatim to
 *   the host and returns the host's workflow id; decide delivers
 *   exactly the `{ type: "approval", payload }` event the agent
 *   used to send itself — no reordering, retry, defaulting, or
 *   payload reshaping.
 * - A host without the needed door fails loud with a named
 *   ApprovalWorkflow error, never silently.
 * - TradingAgent's two scan sites go through the port: the source
 *   no longer calls `this.runWorkflow(` / `this.sendWorkflowEvent(`
 *   directly, and both methods delegate to `approvalWorkflow()`.
 * - Approval semantics are NOT re-pinned here: they stay pinned by
 *   the existing suites (tests/trading_trade_workflow.test.ts,
 *   tests/trading_door_blocking_audit_2178.test.ts,
 *   tests/trading_trace_steps_2730.test.ts), which stub the host
 *   doors on the agent instance — and keep passing because the
 *   adapter resolves the host's doors at call time.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

import {
  createApprovalWorkflow,
  type ApprovalWorkflowHost,
} from "../src/services/cloudflareApprovalWorkflow";
import type { ApprovalWorkflow } from "../src/services/approvalWorkflowPorts";

function recordingHost(): { host: ApprovalWorkflowHost; calls: unknown[] } {
  const calls: unknown[] = [];
  const host: ApprovalWorkflowHost = {
    runWorkflow: async (binding: string, params: unknown) => {
      calls.push(["runWorkflow", binding, params]);
      return "wf-s6-1";
    },
    sendWorkflowEvent: async (binding: string, workflowId: string, event: { type: string; payload: unknown }) => {
      calls.push(["sendWorkflowEvent", binding, workflowId, event]);
    },
  };
  return { host, calls };
}

describe("ApprovalWorkflow port (#1780 S6)", () => {
  it("start passes the binding name and params verbatim and returns the host id", async () => {
    const { host, calls } = recordingHost();
    const port: ApprovalWorkflow = createApprovalWorkflow(host, "TRADE_WORKFLOW");
    const params = { orderId: "draft-s6", userLogin: "alice", traceparent: "00-abc-def-01" };
    await expect(port.start(params)).resolves.toBe("wf-s6-1");
    expect(calls).toEqual([["runWorkflow", "TRADE_WORKFLOW", params]]);
  });

  it("decide delivers exactly the approval event the agent used to send itself", async () => {
    const { host, calls } = recordingHost();
    const port: ApprovalWorkflow = createApprovalWorkflow(host, "TRADE_WORKFLOW");
    await port.decide("wf-s6-1", {
      decision: "approved",
      authorizerDid: "did:web:alice",
      reason: "looks good",
      expectedTerms: { symbol: "CRWV" },
    });
    expect(calls).toEqual([
      [
        "sendWorkflowEvent",
        "TRADE_WORKFLOW",
        "wf-s6-1",
        {
          type: "approval",
          payload: {
            decision: "approved",
            authorizerDid: "did:web:alice",
            reason: "looks good",
            expectedTerms: { symbol: "CRWV" },
          },
        },
      ],
    ]);
  });

  it("a host without runWorkflow fails loud with a named ApprovalWorkflow error", async () => {
    const port = createApprovalWorkflow({} as ApprovalWorkflowHost, "TRADE_WORKFLOW");
    await expect(port.start({ orderId: "draft-s6", userLogin: "alice" })).rejects.toThrowError(
      /ApprovalWorkflow.*runWorkflow/,
    );
  });

  it("a host without sendWorkflowEvent fails loud with a named ApprovalWorkflow error", async () => {
    const port = createApprovalWorkflow({} as ApprovalWorkflowHost, "TRADE_WORKFLOW");
    await expect(
      port.decide("wf-s6-1", { decision: "rejected", authorizerDid: "did:web:alice" }),
    ).rejects.toThrowError(/ApprovalWorkflow.*sendWorkflowEvent/);
  });

  it("TradingAgent routes both workflow operations through the port, not the SDK doors directly", () => {
    const source = fs.readFileSync(
      path.join(__dirname, "../src/agents/trading-agent.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/await this\.runWorkflow\(/);
    expect(source).not.toMatch(/await this\.sendWorkflowEvent\(/);
    expect(source).toMatch(/approvalWorkflow\(\)\.start\(/);
    expect(source).toMatch(/approvalWorkflow\(\)\.decide\(/);
  });
});
