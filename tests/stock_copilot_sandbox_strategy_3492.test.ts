/**
 * Issue #3492 / #3779 — Stock Copilot Strategy Code Generation, Workspace & Sandbox Runner Tests.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  createAgentWorkspace,
  normalizeWorkspacePath,
  type AgentWorkspace,
} from "../src/services/agentWorkspace";
import {
  generateStrategyCode,
  runStrategyInSandbox,
} from "../src/services/stockCopilotStrategySandbox";
import { findCopilot } from "../src/client/chat/copilotRegistry";
import { SandboxAgent } from "../src/agents/sandbox-agent";

function stripJsonc(src: string): string {
  let out = "";
  let inStr = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      out += c;
      if (c === "\\") out += src[++i] ?? "";
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      out += c;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i += 2;
      while (i < src.length && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

describe("Capability S7 (#3491) — Agent Workspace Filesystem", () => {
  it("normalizes paths and prevents directory traversal attacks", () => {
    expect(normalizeWorkspacePath("test.py")).toBe("/test.py");
    expect(normalizeWorkspacePath("/workspace/strategies/../test.ts")).toBe("/workspace/test.ts");
    expect(normalizeWorkspacePath("/a/b/../../c/d")).toBe("/c/d");
    expect(() => normalizeWorkspacePath("")).toThrow("Workspace path must be a non-empty string");
  });

  it("supports writing, reading, stat, and deleting files in workspace", async () => {
    const ws: AgentWorkspace = createAgentWorkspace();
    const filePath = "/workspace/strategies/momentum.py";
    const content = "print('Hello from momentum strategy')";

    expect(await ws.exists(filePath)).toBe(false);
    const saved = await ws.writeFile(filePath, content);
    expect(saved.path).toBe(filePath);
    expect(saved.size).toBe(content.length);
    expect(await ws.exists(filePath)).toBe(true);

    const read = await ws.readFile(filePath);
    expect(read).toBe(content);

    const st = await ws.stat(filePath);
    expect(st?.path).toBe(filePath);
    expect(st?.size).toBe(content.length);

    const deleted = await ws.deleteFile(filePath);
    expect(deleted).toBe(true);
    expect(await ws.exists(filePath)).toBe(false);
  });

  it("lists directory contents and entries hierarchically", async () => {
    const ws: AgentWorkspace = createAgentWorkspace();
    await ws.writeFile("/workspace/strategies/alpha.ts", "export const a = 1;");
    await ws.writeFile("/workspace/strategies/beta.ts", "export const b = 2;");
    await ws.writeFile("/workspace/data/bars.json", "[]");

    const rootDirs = await ws.readdir("/");
    expect(rootDirs).toContain("workspace");

    const wsSub = await ws.readdir("/workspace");
    expect(wsSub).toEqual(["data", "strategies"]);

    const files = await ws.listFiles("/workspace/strategies");
    expect(files.map((f) => f.path)).toEqual([
      "/workspace/strategies/alpha.ts",
      "/workspace/strategies/beta.ts",
    ]);
  });
});

describe("Capability S8 (#3492) — Strategy Code Generation & Sandbox Runner", () => {
  it("synthesizes TypeScript quantitative strategy code and writes to workspace", async () => {
    const ws = createAgentWorkspace();
    const strat = await generateStrategyCode(
      {
        symbol: "NVDA",
        strategyType: "momentum_breakout",
        language: "typescript",
        parameters: { fast: 5, slow: 20 },
      },
      ws,
    );

    expect(strat.symbol).toBe("NVDA");
    expect(strat.language).toBe("typescript");
    expect(strat.workspacePath).toBe("/workspace/strategies/nvda_momentum_breakout.ts");
    expect(strat.code).toContain("NVDAMomentumBreakoutStrategy");
    expect(strat.code).toContain("fastPeriod: number = 5");
    expect(strat.code).toContain("slowPeriod: number = 20");
    expect(strat.entryRules.length).toBeGreaterThan(0);
    expect(strat.exitRules.length).toBeGreaterThan(0);

    const savedInWs = await ws.readFile(strat.workspacePath);
    expect(savedInWs).toBe(strat.code);
  });

  it("synthesizes Python quantitative strategy code and writes to workspace", async () => {
    const ws = createAgentWorkspace();
    const strat = await generateStrategyCode(
      {
        symbol: "AAPL",
        strategyType: "mean_reversion",
        language: "python",
      },
      ws,
    );

    expect(strat.symbol).toBe("AAPL");
    expect(strat.language).toBe("python");
    expect(strat.workspacePath).toBe("/workspace/strategies/aapl_mean_reversion.py");
    expect(strat.code).toContain("SYMBOL = \"AAPL\"");
    expect(strat.code).toContain("def calculate_signals");

    expect(await ws.exists(strat.workspacePath)).toBe(true);
  });

  it("executes strategy in sandbox and evaluates deterministic backtest metrics", async () => {
    const ws = createAgentWorkspace();
    await generateStrategyCode(
      {
        symbol: "TSLA",
        strategyType: "rsi_reversal",
        language: "typescript",
      },
      ws,
    );

    const runResult = await runStrategyInSandbox(
      {
        symbol: "TSLA",
        strategyType: "rsi_reversal",
        bars: 120,
      },
      undefined,
      ws,
    );

    expect(runResult.ok).toBe(true);
    expect(runResult.symbol).toBe("TSLA");
    expect(runResult.strategyType).toBe("rsi_reversal");
    expect(runResult.metrics).toBeDefined();
    expect(typeof runResult.metrics?.sharpeRatio).toBe("number");
    expect(typeof runResult.metrics?.winRatePct).toBe("number");
    expect(runResult.metrics?.dataSource).toBe("synthetic");
    expect(runResult.explanationMarkdown).toContain("TSLA");
    expect(runResult.explanationMarkdown).toContain("Sharpe Ratio");
  });
});

describe("Stock Copilot Quick-Chips Registration (#3779)", () => {
  it("registers strategy code generation and sandboxed backtest quick-chips", () => {
    const copilot = findCopilot("stock");
    expect(copilot).toBeDefined();
    const labels = copilot?.quickChips?.map((c) => c.label) || [];
    expect(labels).toContain("⚡ Generate strategy code");
    expect(labels).toContain("🧪 Run sandboxed backtest");

    const genChip = copilot?.quickChips?.find((c) => c.label === "⚡ Generate strategy code");
    expect(genChip?.prompt).toContain("Generate quantitative trading strategy code");
    expect(genChip?.category).toBe("Strategy Code & Sandbox");

    const backtestChip = copilot?.quickChips?.find((c) => c.label === "🧪 Run sandboxed backtest");
    expect(backtestChip?.prompt).toContain("Run the generated momentum breakout strategy in SandboxAgent");
    expect(backtestChip?.category).toBe("Strategy Code & Sandbox");
  });
});

describe("Wrangler Containers Configuration & SandboxAgent Readiness (#3492)", () => {
  it("wrangler.jsonc declares containers configuration for SandboxAgent", () => {
    const raw = readFileSync("wrangler.jsonc", "utf8");
    const wrangler = JSON.parse(stripJsonc(raw));
    expect(wrangler.containers).toBeDefined();
    expect(Array.isArray(wrangler.containers)).toBe(true);
    expect(wrangler.containers).toHaveLength(1);
    expect(wrangler.containers[0].class_name).toBe("SandboxAgent");
    // Issue #3789: wrangler 4.156.0 rejects the `image` field on a
    // Durable Object-managed containers entry ("Unsupported fields for
    // Durable Object-managed Containers in containers: \"image\"..."),
    // which broke Deploy from bb24be82 on. The image is supplied at
    // runtime by ETradeSandboxService.runCommand via
    // container.start({ image: "cloudflare/debian-trixie", ... }).
    expect(wrangler.containers[0]).not.toHaveProperty("image");
    expect(wrangler.containers[0].scheduling_policy).toBe("durable_object");
  });

  it("SandboxAgent binds container when available on ctx", () => {
    const container = {
      running: true,
      exec: async () => ({
        exitCode: 0,
        output: async () => ({
          exitCode: 0,
          stdout: new Uint8Array([111, 107]),
          stderr: new Uint8Array([]),
        }),
      }),
    };
    const ctx = {
      id: { toString: () => "sandbox-1" },
      container,
    } as any;
    const agent = new SandboxAgent(ctx, {} as any);
    const status = agent.sandboxStatus();
    expect(status.backendConfigured).toBe(true);
    expect(status.degraded).toBe(false);
  });
});

