/**
 * Issue #2732 (tracker #2708 item A4 — the #2253 follow-up) —
 * run_sandbox_command resolves through the SandboxAgent class.
 *
 * Until this slice, SandboxRunCommand constructed ETradeSandboxService
 * directly, bypassing SandboxAgent — the fleet class #2253 built as
 * the sandbox's agent surface and the class every other door (A2A,
 * HTTP onRequest) already reaches the capability through. These pins
 * freeze the wiring and the behavior parity it must preserve:
 *
 *  - Source: no direct service construction remains in
 *    SandboxRunCommand; the one remaining construction in the file is
 *    QuantBacktestCommand's (the backtest never touches a container —
 *    a deterministic in-process calculation, #121 F7 — and is a
 *    separate disposition, recorded in #2732).
 *  - Resolution: the command resolves the SandboxAgent stub on the
 *    SANDBOX_AGENT binding at the fixed service instance "sandbox"
 *    (the instance the A2A resolution addresses by URL-name parity)
 *    and returns the stub's runCommand result verbatim.
 *  - Configured parity: with a namespace backed by a REAL
 *    SandboxAgent instance, the result equals the direct-service
 *    result (modulo durationMs) — the class delegates to the same
 *    service construction, so the #121 honest not-executed shape is
 *    now served via the class, unchanged.
 *  - Unconfigured parity: with no SANDBOX_AGENT binding in env, the
 *    command answers in the same honest shape (executed:false,
 *    exitCode:null, an explicit not-executed reason naming the
 *    binding) and audits the same event — never a throw, never
 *    fabricated output.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SandboxRunCommand } from "../src/mcps/openaimp/cloudflareAgentCommands";
import { SandboxAgent } from "../src/agents/sandbox-agent";
import { ETradeSandboxService } from "../src/services/sandboxAgent";
import type { Env, SandboxExecutionResult } from "../src/types";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(resolve(root, rel), "utf8");

const stubContext = (env: unknown, auditLog: any[]) =>
  ({
    env,
    orm: undefined,
    sessionId: "test-session",
    audit: (type: string, agent: any, payload: Record<string, unknown>) =>
      auditLog.push({ type, agent, payload }),
  }) as any;

/** A fake DurableObjectNamespace that records how it was addressed. */
function fakeNamespace(stub: unknown) {
  const calls: { idFromName: string[]; get: unknown[] } = {
    idFromName: [],
    get: [],
  };
  const namespace = {
    idFromName: (name: string) => {
      calls.idFromName.push(name);
      return { name };
    },
    get: (id: unknown) => {
      calls.get.push(id);
      return stub;
    },
  };
  return { namespace, calls };
}

describe("run_sandbox_command wiring (#2732)", () => {
  it("source pin: SandboxRunCommand constructs no service — it addresses the SandboxAgent binding", () => {
    const src = read("src/mcps/openaimp/cloudflareAgentCommands.ts");
    const start = src.indexOf("export class SandboxRunCommand");
    const end = src.indexOf("export class", start + 1);
    const classBody = src.slice(start, end === -1 ? undefined : end);
    expect(classBody).not.toContain("ETradeSandboxService");
    expect(classBody).toContain("SANDBOX_AGENT");
    expect(classBody).toContain("runCommand");
    // The file's one remaining direct construction is
    // QuantBacktestCommand's — deliberate (see this suite's header).
    expect(src.match(/new ETradeSandboxService/g)).toHaveLength(1);
  });

  it("resolution: resolves the service instance 'sandbox' and returns the stub's result verbatim", async () => {
    const seen: any[] = [];
    const sentinel: SandboxExecutionResult = {
      executed: true,
      exitCode: 0,
      stdout: "sentinel-stdout",
      stderr: "",
      durationMs: 3,
    };
    const stub = {
      runCommand: async (request: any) => {
        seen.push(request);
        return sentinel;
      },
    };
    const { namespace, calls } = fakeNamespace(stub);
    const auditLog: any[] = [];
    const cmd = new SandboxRunCommand();
    const result = await cmd.execute(
      { command: "echo hi", timeoutMs: 5000 },
      stubContext({ SANDBOX_AGENT: namespace }, auditLog),
    );

    expect(calls.idFromName).toEqual(["sandbox"]);
    expect(calls.get).toEqual([{ name: "sandbox" }]);
    expect(seen).toEqual([{ command: "echo hi", timeoutMs: 5000 }]);
    expect(result).toBe(sentinel);
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].type).toBe("sandbox.execute");
    expect(auditLog[0].payload).toEqual({
      command: "echo hi",
      executed: true,
      exitCode: 0,
    });
  });

  it("configured parity: a namespace backed by a real SandboxAgent serves the service's honest result", async () => {
    const agent = new SandboxAgent(
      { id: { toString: () => "sandbox-2732" } } as any,
      {} as unknown as Env,
    );
    const stub = { runCommand: (req: any) => agent.runCommand(req) };
    const { namespace, calls } = fakeNamespace(stub);
    const auditLog: any[] = [];
    const cmd = new SandboxRunCommand();
    const result = await cmd.execute(
      { command: "echo hello" },
      stubContext({ SANDBOX_AGENT: namespace }, auditLog),
    );

    // The seam was actually used (this is what "wired" means) …
    expect(calls.idFromName).toEqual(["sandbox"]);
    // … and the answer is the direct-service answer, unchanged.
    const direct = await new ETradeSandboxService(undefined, undefined).runCommand({
      command: "echo hello",
    });
    const { durationMs: _r, ...resultRest } = result;
    const { durationMs: _d, ...directRest } = direct;
    expect(resultRest).toEqual(directRest);
    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("NOT executed");
    expect(auditLog[0].payload.executed).toBe(false);
    expect(auditLog[0].payload.exitCode).toBeNull();
  });

  it("unconfigured parity: no SANDBOX_AGENT binding → honest not-executed shape, same audit, no throw", async () => {
    const auditLog: any[] = [];
    const cmd = new SandboxRunCommand();
    const result = await cmd.execute(
      { command: "echo hi" },
      stubContext({}, auditLog),
    );

    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(result.error).toContain("NOT executed");
    expect(result.error).toContain("SANDBOX_AGENT");
    expect(auditLog).toHaveLength(1);
    expect(auditLog[0].type).toBe("sandbox.execute");
    expect(auditLog[0].payload.executed).toBe(false);
    expect(auditLog[0].payload.exitCode).toBeNull();
  });

  it("unconfigured parity: a malformed namespace answers the same honest shape", async () => {
    const auditLog: any[] = [];
    const cmd = new SandboxRunCommand();
    const result = await cmd.execute(
      { command: "echo hi" },
      stubContext({ SANDBOX_AGENT: { not: "a namespace" } }, auditLog),
    );
    expect(result.executed).toBe(false);
    expect(result.exitCode).toBeNull();
    expect(result.error).toContain("SANDBOX_AGENT");
  });

  it("tool description names the class path and keeps the honesty markers", () => {
    const cmd = new SandboxRunCommand();
    expect(cmd.description).toContain("SandboxAgent");
    expect(cmd.description).toContain("executed:false");
    expect(cmd.description).toContain("never emulated");
  });
});
