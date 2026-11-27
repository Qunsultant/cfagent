/**
 * Issue #6710 — a feed dispatch must settle within the externalized
 * bounds even when the pipeline host never answers.
 *
 * Live evidence (#3992 comment 7229033821): a re-armed Alpaca
 * feed-run sat running ~16 minutes with no terminal record and no
 * named refusal, past the 270s door bound. The bound lived inside
 * the host, so a host that never enters the door (startup gate,
 * wedged instance) left every caller await unsettled. These pins
 * hold the fix: the route races the door dispatch against the
 * door bound and refuses FEED_DEADLINE_EXCEEDED by name, and the
 * workflow dispatch's status reads cannot outlive its deadline.
 */
import { describe, it, expect } from "vitest";
import { MockSqlStorage } from "./mock-sql";
import { seedProviderConfigs } from "../src/trading/dataProviders/providerConfigStore";
import {
  handleDataProviderRoutes,
  type DataProviderRoutesContext,
  type FeedPipelineDoorLike,
} from "../src/agents/routes/dataProviders";
import { InMemoryFeedDatasetStore } from "../src/data/inMemoryFeedDatasetAdapter";
import { dispatchFeedJobWorkflow } from "../src/agents/scheduledTasksPipeline";
import { boundedPipelineHostStartupLeg } from "../src/agents/scheduled-agent";
import type { Env } from "../src/types";

const SMALL_BOUNDS = {
  FEED_JOB_EXECUTION_MS: "30",
  FEED_JOB_CAPTURE_MS: "20",
  FEED_JOB_WORKFLOW_POLL_MS: "5",
};

function hangingDispatchDoor(): FeedPipelineDoorLike {
  return {
    runPipelineJob: () => new Promise<never>(() => {}),
  } as unknown as FeedPipelineDoorLike;
}

function makeCtx(door: FeedPipelineDoorLike): DataProviderRoutesContext {
  const sql = new MockSqlStorage();
  seedProviderConfigs(sql);
  return {
    env: { ...SMALL_BOUNDS } as unknown as Env,
    sql,
    userLogin: "octocat",
    recordAudit: async () => ({ id: "audit-1" }),
    feedDatasetStore: new InMemoryFeedDatasetStore(),
    feedPipelineDoor: door,
  };
}

function callFeedRun(ctx: DataProviderRoutesContext): Promise<Response> {
  const url = new URL("https://agent.internal/data-providers/alpaca/feed-run");
  return handleDataProviderRoutes(
    new Request(url, { method: "POST" }),
    url,
    url.pathname,
    "session-1",
    ctx,
  ) as Promise<Response>;
}

describe("Feed dispatch settle bound (#6710)", () => {
  it("POST feed-run refuses FEED_DEADLINE_EXCEEDED when the door never settles", async () => {
    const ctx = makeCtx(hangingDispatchDoor());
    const res = await Promise.race([
      callFeedRun(ctx),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(res).not.toBeNull();
    expect(res!.status).toBe(409);
    const body = (await res!.json()) as any;
    expect(body.code).toBe("FEED_DEADLINE_EXCEEDED");
    expect(body.error).toContain("alpaca-nasdaq100-quotes");
  });

  it("dispatchFeedJobWorkflow refuses by name when a status read never settles", async () => {
    const ctx = {
      env: { ...SMALL_BOUNDS },
      startWorkflow: async () => ({ instanceId: "inst-1" }),
      workflowStatus: () => new Promise<never>(() => {}),
    } as any;
    const outcome = await Promise.race([
      dispatchFeedJobWorkflow(ctx, "alpaca-nasdaq100-quotes", {}).then(
        () => ({ settled: "resolved" as const }),
        (error: unknown) => ({
          settled: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(outcome).not.toBeNull();
    expect(outcome!.settled).toBe("rejected");
    expect((outcome as any).message).toContain("FEED_DEADLINE_EXCEEDED");
  });

  it("dispatchFeedJobWorkflow refuses by name when the workflow start never settles", async () => {
    const ctx = {
      env: { ...SMALL_BOUNDS },
      startWorkflow: () => new Promise<never>(() => {}),
      workflowStatus: async () => ({ status: "running" }),
    } as any;
    const outcome = await Promise.race([
      dispatchFeedJobWorkflow(ctx, "alpaca-nasdaq100-quotes", {}).then(
        () => ({ settled: "resolved" as const }),
        (error: unknown) => ({
          settled: "rejected" as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(outcome).not.toBeNull();
    expect(outcome!.settled).toBe("rejected");
    expect((outcome as any).message).toContain("FEED_DEADLINE_EXCEEDED");
  });

  it("a startup leg that never settles times out by name instead of wedging startup", async () => {
    const outcome = await Promise.race([
      boundedPipelineHostStartupLeg(
        { FEED_JOB_CAPTURE_MS: "20" },
        () => new Promise<never>(() => {}),
      ).then(
        () => ({ settled: "resolved" as const }),
        (error: unknown) => ({
          settled: "rejected" as const,
          code: (error as { code?: string }).code,
          message: error instanceof Error ? error.message : String(error),
        }),
      ),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 2_000)),
    ]);
    expect(outcome).not.toBeNull();
    expect(outcome!.settled).toBe("rejected");
    expect((outcome as any).code).toBe("pipeline_host_startup_leg_timeout");
  });
});
