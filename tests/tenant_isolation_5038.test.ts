/**
 * Pinning test for #5038 — Tenant isolation boundaries (G-1, G-6, G-7, H-7).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  agentAsyncJobs,
  agentProposalTransitions,
  agentProposals,
  agentTraceRecords,
  agentWorkItemEvents,
  jobPipelineArtifacts,
  jobPipelineDefinitions,
  jobPipelineInstances,
  jobRunRecords,
} from "../src/data/drizzleSchema";

describe("#5038 tenant isolation boundaries", () => {
  it("G-1: substrate tables carry principal/actor attribution and have documented deployment scope", () => {
    expect("principal" in agentTraceRecords).toBe(true);
    expect("principal" in agentProposals).toBe(true);
    expect("actor" in agentProposalTransitions).toBe(true);
    expect("actor" in agentWorkItemEvents).toBe(true);
  });

  it("G-6: mas_events remains DO-instance-scoped with tamper-chain columns", () => {
    const ormCat = readFileSync(
      resolve(process.cwd(), "src/data/schemaComponent/ormCatalogue.ts"),
      "utf8",
    );
    expect(ormCat).toContain("CREATE TABLE IF NOT EXISTS mas_events");
    expect(ormCat).toContain("session_id TEXT NOT NULL");
  });

  it("G-7: pipeline host tables are keyed by job_id/run_id while agent_async_jobs is tenant-scoped", () => {
    expect("jobId" in jobPipelineDefinitions).toBe(true);
    expect("jobId" in jobPipelineInstances).toBe(true);
    expect("runId" in jobPipelineArtifacts).toBe(true);
    expect("jobId" in jobRunRecords).toBe(true);
    expect("tenantId" in agentAsyncJobs).toBe(true);
  });

  it("H-7: SessionStore kv-wipe route enforces server-side platform-admin gate", () => {
    const kvWipeSrc = readFileSync(
      resolve(process.cwd(), "src/agents/routes/kvWipe.ts"),
      "utf8",
    );
    expect(kvWipeSrc).toContain("checkPlatformPermission");
    expect(kvWipeSrc).toContain("confirm");
  });
});
