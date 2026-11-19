import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { newAsyncJobId } from "../src/services/executionTreeIds";

const ORCHESTRATOR_SRC = fs.readFileSync(
  path.resolve(process.cwd(), "src/agents/orchestrator.ts"),
  "utf8",
);

describe("Issue #5725 — /jobs/:jobId and /retry match job:<uuid> IDs", () => {
  it("extracts the exact jobMatch and jobRetryMatch patterns from orchestrator.ts and matches newAsyncJobId()", () => {
    const jobMatchLine = ORCHESTRATOR_SRC.match(/const jobMatch = path\.match\((\/[^;]+\/[a-z]*)\);/);
    const jobRetryLine = ORCHESTRATOR_SRC.match(/const jobRetryMatch = path\.match\((\/[^;]+\/[a-z]*)\);/);
    expect(jobMatchLine).not.toBeNull();
    expect(jobRetryLine).not.toBeNull();

    const jobRegex = eval(jobMatchLine![1]) as RegExp;
    const retryRegex = eval(jobRetryLine![1]) as RegExp;

    const id = newAsyncJobId();
    expect(id.startsWith("job:")).toBe(true);

    expect(`/jobs/${id}`.match(jobRegex)?.[1]).toBe(id);
    expect(`/api/jobs/${id}`.match(jobRegex)?.[1]).toBe(id);
    expect(decodeURIComponent(`/jobs/${encodeURIComponent(id)}`.match(jobRegex)?.[1] ?? "")).toBe(id);

    expect(`/jobs/${id}/retry`.match(retryRegex)?.[1]).toBe(id);
    expect(`/api/jobs/${id}/retry`.match(retryRegex)?.[1]).toBe(id);
    expect(decodeURIComponent(`/jobs/${encodeURIComponent(id)}/retry`.match(retryRegex)?.[1] ?? "")).toBe(id);
  });
});
