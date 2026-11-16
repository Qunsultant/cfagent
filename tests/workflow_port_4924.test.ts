/**
 * Issue #4924 — workflow-side port conformance.
 *
 * The five workflow classes extend the PortThinkWorkflow port base
 * (src/workflows/portThinkWorkflow.ts), never the SDK's ThinkWorkflow
 * directly — the workflow-side mirror of the PortThink discipline on
 * the agent side. The port module is the sole
 * "@cloudflare/think/workflows" import site in src/: an SDK upgrade
 * touches one module, and a new workflow class extends the port
 * instead of importing the SDK base.
 *
 * Source-evidence style (repo precedent: tests/agent-conformance):
 * the workflow module graph pulls `cloudflare:` imports the node
 * loader cannot resolve, so the suite pins the adoption evidence
 * itself — the import sites, the base classes, and the preserved
 * generic arguments — while the runtime `instanceof` chain is
 * pinned by tests/goal_screen_thinkworkflow_e2e and
 * tests/trading_trade_workflow.
 */
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8");

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listTsFiles(full));
    else if (entry.name.endsWith(".ts") || entry.name.endsWith(".tsx")) out.push(full);
  }
  return out;
}

const PORT_MODULE = "src/workflows/portThinkWorkflow.ts";
const WORKFLOW_CLASSES: Array<{ className: string; file: string; params: string }> = [
  {
    className: "TradingTradeWorkflow",
    file: "src/agents/trading-trade-workflow.ts",
    params: "TradeApprovalParams",
  },
  {
    className: "ScreenerScreenWorkflow",
    file: "src/workflows/screenerWorkflow.ts",
    params: "WorkflowJobCommand",
  },
  {
    className: "JobPipelineWorkflow",
    file: "src/workflows/jobPipelineWorkflow.ts",
    params: "JobPipelineWorkflowPayload",
  },
  {
    className: "PaymentWorkflow",
    file: "src/workflows/paymentWorkflow.ts",
    params: "PaymentWorkflowEventParams",
  },
  {
    className: "CrossDomainSagaWorkflow",
    file: "src/workflows/sagaWorkflow.ts",
    params: "SagaParams",
  },
];

describe("Workflow-side port (issue #4924)", () => {
  it("the port module is the sole @cloudflare/think/workflows import site in src/", () => {
    const importers = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => read(path.relative(ROOT, f)).includes('from "@cloudflare/think/workflows"'))
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"))
      .sort();
    expect(importers).toEqual([PORT_MODULE]);
  });

  it("all five workflow classes extend the port base", () => {
    const found = new Map<string, string>();
    for (const f of listTsFiles(path.join(ROOT, "src"))) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/export\s+class\s+(\w+)\s+extends\s+PortThinkWorkflow\b/g)) {
        found.set(m[1], path.relative(ROOT, f).replace(/\\/g, "/"));
      }
    }
    expect([...found.keys()].sort()).toEqual(WORKFLOW_CLASSES.map((c) => c.className).sort());
    for (const c of WORKFLOW_CLASSES) {
      expect(found.get(c.className)).toBe(c.file);
    }
  });

  it("each class preserves its generic type arguments", () => {
    for (const c of WORKFLOW_CLASSES) {
      const src = read(c.file);
      const start = src.indexOf("extends PortThinkWorkflow<");
      expect(start, `${c.className} extends clause`).toBeGreaterThan(-1);
      const end = src.indexOf("> {", start);
      expect(end, `${c.className} extends clause terminator`).toBeGreaterThan(-1);
      const clause = src.slice(start, end);
      expect(clause).toContain("any");
      expect(clause).toContain(c.params);
      expect(clause).toContain("DefaultProgress");
      expect(clause).toContain("Env");
    }
  });

  it("the port base extends ThinkWorkflow and no other class in src/ does", () => {
    const portSrc = read(PORT_MODULE);
    expect(portSrc).toMatch(/export\s+class\s+PortThinkWorkflow[\s\S]*?extends\s+ThinkWorkflow</);
    const direct = listTsFiles(path.join(ROOT, "src"))
      .filter((f) => {
        const rel = path.relative(ROOT, f).replace(/\\/g, "/");
        if (rel === PORT_MODULE) return false;
        return /export\s+class\s+\w+\s+extends\s+ThinkWorkflow\b/.test(
          fs.readFileSync(f, "utf8"),
        );
      })
      .map((f) => path.relative(ROOT, f).replace(/\\/g, "/"));
    expect(direct).toEqual([]);
  });
});
