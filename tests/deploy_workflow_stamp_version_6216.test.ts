/**
 * Issue #6216 — [#6167 follow-up] the stillborn gate never fires in
 * production: host_version is always NULL because CF_VERSION_METADATA
 * is unavailable in the Durable Object.
 *
 * The fix injects the deploy-time git SHA as the CF_DEPLOY_VERSION
 * var (a plain var, visible in the DO env) — the deploy workflow
 * stamps it into wrangler.jsonc before `wrangler deploy`. These
 * assertions pin the stamp step's shape in deploy.yml and the
 * placeholder in wrangler.jsonc, so a workflow edit that drops the
 * stamp (or a wrangler.jsonc edit that drops the placeholder) fails
 * here instead of silently returning the claim to null and the gate
 * to inert.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const workflow = readFileSync(
  new URL("../.github/workflows/deploy.yml", import.meta.url),
  "utf-8",
);
const wrangler = readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf-8");

describe("deploy.yml — deploy version stamp (#6216)", () => {
  it("has a step that stamps the deployed SHA into wrangler.jsonc", () => {
    expect(workflow).toContain("Stamp deploy version into wrangler.jsonc");
  });

  it("resolves the SHA from the CI head_sha, falling back to github.sha for manual dispatch", () => {
    expect(workflow).toContain(
      'DEPLOY_SHA="${{ github.event.workflow_run.head_sha || github.sha }}"',
    );
  });

  it("replaces the CF_DEPLOY_VERSION placeholder with the SHA", () => {
    expect(workflow).toContain('sed -i "s/<DEPLOY_VERSION>/$DEPLOY_SHA/g" wrangler.jsonc');
  });

  it("fails closed when the SHA cannot be resolved or the stamp does not land", () => {
    const stamp = workflow.slice(
      workflow.indexOf("Stamp deploy version into wrangler.jsonc"),
    );
    expect(stamp).toContain('if [ -z "$DEPLOY_SHA" ]');
    expect(stamp).toContain('grep -q "$DEPLOY_SHA" wrangler.jsonc');
    expect(stamp.match(/exit 1/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("stamps the version before the Deploy Worker step runs", () => {
    const stampAt = workflow.indexOf("Stamp deploy version into wrangler.jsonc");
    const deployAt = workflow.indexOf("Deploy Worker");
    expect(stampAt).toBeGreaterThan(-1);
    expect(deployAt).toBeGreaterThan(-1);
    expect(stampAt).toBeLessThan(deployAt);
  });

  it("wrangler.jsonc carries the CF_DEPLOY_VERSION placeholder the stamp replaces", () => {
    expect(wrangler).toContain('"CF_DEPLOY_VERSION": "<DEPLOY_VERSION>"');
  });
});
