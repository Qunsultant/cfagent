/**
 * Issue #3072 - the options seam pins.
 *
 * Options has no durable steps, so the risk here is the opposite of payment's:
 * publishing a boundary for a phase that has no artifact, i.e. claiming
 * evidence the run never produced. These pins make "no artifact, no message"
 * the enforced rule rather than a comment.
 */
import { describe, expect, it, vi } from "vitest";
import { emitOptionsStageBoundaries } from "../src/workflows/optionsStageSeam";
import { OPTIONS_SCREEN_PHASES } from "../src/workflows/stageRuntimeIds";

describe("options stage boundaries (#3072)", () => {
  it("publishes every phase when every artifact exists, in phase order", async () => {
    const sent: string[] = [];
    const result = await emitOptionsStageBoundaries({
      artifacts: {
        runId: "gen-1",
        userLogin: "owner@example.com",
        reportKey: "options:pdf:gen-1",
        deliveryState: "options:delivery:gen-1:posted",
      },
      queue: { send: async (body: unknown) => sent.push((body as { stageId: string }).stageId) },
      warn: () => undefined,
    });
    expect(sent).toEqual([...OPTIONS_SCREEN_PHASES]);
    expect(result.published).toEqual([...OPTIONS_SCREEN_PHASES]);
    expect(result.skipped).toEqual([]);
  });

  it("publishes nothing when the run produced no artifact", async () => {
    const warn = vi.fn();
    const sent: string[] = [];
    const result = await emitOptionsStageBoundaries({
      artifacts: { runId: "gen-1", userLogin: "owner@example.com" },
      queue: { send: async (body: unknown) => sent.push((body as { stageId: string }).stageId) },
      warn,
    });
    expect(sent).toEqual([]);
    expect(result.published).toEqual([]);
    expect(result.skipped.map((entry) => entry.stageId)).toEqual([...OPTIONS_SCREEN_PHASES]);
    expect(warn).toHaveBeenCalledTimes(OPTIONS_SCREEN_PHASES.length);
  });

  it("skips only the phases whose artifact is missing", async () => {
    const sent: string[] = [];
    const result = await emitOptionsStageBoundaries({
      artifacts: { runId: "gen-1", userLogin: "owner@example.com", reportKey: "options:pdf:gen-1" },
      queue: { send: async (body: unknown) => sent.push((body as { stageId: string }).stageId) },
      warn: () => undefined,
    });
    expect(sent).toEqual(["provider-screen", "report-pipeline"]);
    expect(result.skipped.map((entry) => entry.stageId)).toEqual(["deliver"]);
  });

  it("degrades to skips when no queue is bound, without throwing", async () => {
    const result = await emitOptionsStageBoundaries({
      artifacts: {
        runId: "gen-1",
        userLogin: "owner@example.com",
        reportKey: "options:pdf:gen-1",
        deliveryState: "options:delivery:gen-1:posted",
      },
      queue: null,
      warn: () => undefined,
    });
    expect(result.published).toEqual([]);
    expect(result.skipped).toHaveLength(OPTIONS_SCREEN_PHASES.length);
  });

  it("references the run's own artifact key, never an empty one", async () => {
    const messages: Array<{ artifactKeys: string[]; runId: string; family?: string }> = [];
    await emitOptionsStageBoundaries({
      artifacts: { runId: "gen-1", userLogin: "owner@example.com", reportKey: "options:pdf:gen-1" },
      queue: { send: async (body: unknown) => messages.push(body as never) },
      warn: () => undefined,
    });
    for (const message of messages) {
      expect(message.family).toBe("options");
      expect(message.runId).toBe("gen-1");
      expect(message.artifactKeys[0]?.length).toBeGreaterThan(0);
    }
  });
});
