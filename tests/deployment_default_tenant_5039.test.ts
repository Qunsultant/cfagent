/**
 * Pinning test for #5039 — One deployment-default tenant.
 *
 * Asserts:
 *  1. The single deployment-default tenant literal is `"primary"` in
 *     `src/config/tenantDefaults.ts` (`DEPLOYMENT_DEFAULT_TENANT_ID` and
 *     `DEPLOYMENT_DEFAULT_WORKSPACE_ID`).
 *  2. All default-tenant paths resolve to `DEPLOYMENT_DEFAULT_TENANT_ID`:
 *     - IAAA (`IAAA_DEFAULT_TENANT_ID`, `resolveIaaaTenant`)
 *     - Provider captures (`resolveRunContext`, `resolveCaptureUserLogin`,
 *       and `routes/dataProviders.ts` `CAPTURE_TENANT_ID`)
 *     - Chain-schedule reconciliation (`scheduled-agent.ts`)
 *     - Canonical report seeding (`canonicalReportSeed.ts`)
 *     - Workflow-runs route fallback (`routes/workflowRuns.ts`)
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_DEFAULT_TENANT_ID,
  DEPLOYMENT_DEFAULT_WORKSPACE_ID,
} from "../src/config/tenantDefaults";
import {
  IAAA_DEFAULT_TENANT_ID,
  resolveIaaaTenant,
} from "../src/security/iaaaGithubEndToEnd";
import {
  resolveCaptureUserLogin,
  resolveRunContext,
} from "../src/data/providerCapturePorts";

function readSource(relPath: string): string {
  return readFileSync(resolve(process.cwd(), relPath), "utf8");
}

describe("#5039 single deployment-default tenant", () => {
  it("pins DEPLOYMENT_DEFAULT_TENANT_ID and DEPLOYMENT_DEFAULT_WORKSPACE_ID to 'primary'", () => {
    expect(DEPLOYMENT_DEFAULT_TENANT_ID).toBe("primary");
    expect(DEPLOYMENT_DEFAULT_WORKSPACE_ID).toBe("primary");
  });

  it("wires IAAA and provider-capture runtime resolvers to the single default", () => {
    expect(IAAA_DEFAULT_TENANT_ID).toBe(DEPLOYMENT_DEFAULT_TENANT_ID);
    expect(resolveIaaaTenant({})).toBe(DEPLOYMENT_DEFAULT_TENANT_ID);
    expect(resolveIaaaTenant(null)).toBe(DEPLOYMENT_DEFAULT_TENANT_ID);

    const captureCtx = resolveRunContext(undefined);
    expect(captureCtx.tenantId).toBe(DEPLOYMENT_DEFAULT_TENANT_ID);
    expect(resolveCaptureUserLogin(null, DEPLOYMENT_DEFAULT_TENANT_ID)).toBe("system");
    expect(resolveCaptureUserLogin(null, "tenant-2")).toBe("tenant-2");
  });

  it("wires every default-tenant call site to tenantDefaults without diverging literals", () => {
    const dataProvidersSrc = readSource("src/agents/routes/dataProviders.ts");
    expect(dataProvidersSrc).toContain("DEPLOYMENT_DEFAULT_TENANT_ID");
    expect(dataProvidersSrc).not.toMatch(/const CAPTURE_TENANT_ID\s*=\s*"default"/);

    const canonicalSeedSrc = readSource("src/agents/orchestrator/canonicalReportSeed.ts");
    expect(canonicalSeedSrc).toContain("DEPLOYMENT_DEFAULT_WORKSPACE_ID");
    expect(canonicalSeedSrc).not.toMatch(/workspaceId:\s*"primary"/);

    const scheduledAgentSrc = readSource("src/agents/scheduled-agent.ts");
    expect(scheduledAgentSrc).toContain("DEPLOYMENT_DEFAULT_TENANT_ID");
    expect(scheduledAgentSrc).toContain("DEPLOYMENT_DEFAULT_WORKSPACE_ID");
    expect(scheduledAgentSrc).not.toMatch(/tenantId:\s*string\s*=\s*"primary"/);

    const workflowRunsSrc = readSource("src/agents/routes/workflowRuns.ts");
    expect(workflowRunsSrc).toContain("DEPLOYMENT_DEFAULT_TENANT_ID");
    expect(workflowRunsSrc).not.toMatch(/resolveIaaaTenant\([^)]+\)\s*:\s*"primary"/);
  });
});
