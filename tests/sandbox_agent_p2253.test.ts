/**
 * Issue #2253 — SandboxAgent behaviour pins.
 *
 * The agent is fleet registration plus a thin door over the existing
 * ETradeSandboxService, constructed with no container backend —
 * exactly as the MCP facade (RunSandboxCommand) constructs it today.
 * These pins run the REAL service at the seam (no mocks): with no
 * backend bound, the run door must return the service's honest
 * not-executed result (#121: executed:false, exitCode:null, explicit
 * error) and the status surface must report the degradation plainly.
 * A fabricated success here is precisely the failure this suite
 * exists to catch.
 */
import { describe, it, expect } from "vitest";
import { SandboxAgent } from "../src/agents/sandbox-agent";
import type { Env } from "../src/types";

const fakeCtx = { id: { toString: () => "sandbox-p2253" } } as any;
const fakeEnv = {} as unknown as Env;

describe("SandboxAgent (issue #2253)", () => {
  it("status reports the degraded posture: no backend configured", () => {
    const agent = new SandboxAgent(fakeCtx, fakeEnv);
    const status = agent.sandboxStatus();
    expect(status.agent).toBe("SandboxAgent");
    expect(status.backendConfigured).toBe(false);
    expect(status.degraded).toBe(true);
  });

  it("status reports active when container backend is bound (issue #3492)", () => {
    const containerCtx = {
      id: { toString: () => "sandbox-p2253-bound" },
      container: { running: true },
    } as any;
    const agent = new SandboxAgent(containerCtx, fakeEnv);
    const status = agent.sandboxStatus();
    expect(status.agent).toBe("SandboxAgent");
    expect(status.backendConfigured).toBe(true);
    expect(status.degraded).toBe(false);
    expect(status.detail).toContain("Active");
  });

  it("run door delegates to the real service: no backend → NOT executed, never emulated", async () => {
    const agent = new SandboxAgent(fakeCtx, fakeEnv);
    const result = await agent.runCommand({ command: "echo hello-from-sandbox" });
    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error).toContain("NOT executed");
  });

  it("onRequest health surface reports the same degraded status", async () => {
    const agent = new SandboxAgent(fakeCtx, fakeEnv);
    const res = await agent.onRequest(new Request("https://agent.internal/health"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.agent).toBe("SandboxAgent");
    expect(body.backendConfigured).toBe(false);
  });

  it("onRequest POST /run returns the honest not-executed result", async () => {
    const agent = new SandboxAgent(fakeCtx, fakeEnv);
    const res = await agent.onRequest(
      new Request("https://agent.internal/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command: "echo hi" }),
      })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.executed).toBe(false);
    expect(body.exitCode).toBeNull();
  });

  it("onRequest answers 404 for unknown paths", async () => {
    const agent = new SandboxAgent(fakeCtx, fakeEnv);
    const res = await agent.onRequest(new Request("https://agent.internal/nope"));
    expect(res.status).toBe(404);
  });
});
