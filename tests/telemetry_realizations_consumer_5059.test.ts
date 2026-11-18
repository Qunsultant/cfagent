/**
 * Issue #5059 (AG-5) — `agent_thesis_realizations` gets a content consumer.
 *
 * The telemetry projector writes one row per evaluated research idea and the
 * only readers were a dedupe check and a test-only engine call: no production
 * path read the rows for what they say. The reconcile route now runs the
 * calibration engine after importing, so fresh realizations become
 * falsification-driven calibration proposals for human review — the table's
 * content drives something.
 */
import { describe, it, expect } from "vitest";
import { InMemoryTelemetryAdapter } from "../src/telemetry/inMemoryTelemetryAdapter";
import {
  handleTelemetryReconcileRoute,
  type TelemetryReconcileReport,
} from "../src/telemetry/telemetryRoute";
import { TelemetryCalibrationEngine } from "../src/telemetry/telemetryPorts";

const ADMIN = { githubLogin: "owner:alice", internalUserId: "user-1" };

function falsifiedIdeas(count: number, thesis = "condor-bias") {
  return Array.from({ length: count }, (_, i) => ({
    runId: `run-${i}`,
    symbol: "NVDA",
    structure: "iron-condor",
    thesis,
    outlook: "bullish",
    regime: "high-iv",
    evaluation: {
      directionCorrect: false,
      evaluatedAt: `2025-10-${String((i % 20) + 1).padStart(2, "0")}T00:00:00.000Z`,
    },
  }));
}

function baseDeps(ideas: unknown[], store = new InMemoryTelemetryAdapter()) {
  return {
    store,
    ideas,
    deps: {
      method: "POST",
      tenantId: "primary",
      store,
      session: ADMIN,
      isPlatformAdmin: true,
      userLogin: "owner:alice",
      loadTrackRecord: async () => ({ ideas: ideas as never }),
    },
  };
}

describe("Issue #5059 — realizations feed the calibration engine", () => {
  it("proposes a calibration decision from freshly imported realizations", async () => {
    const { deps } = baseDeps(falsifiedIdeas(24));

    const response = await handleTelemetryReconcileRoute(deps);
    const report = (await response.json()) as TelemetryReconcileReport;

    expect(report.imported).toBe(24);
    expect(report.calibrationsCreated).toBe(1);
    expect(report.calibrationError).toBeNull();

    // The proposal is a real decision row, awaiting human review — the table's
    // content is what produced it.
    const decisions = await deps.store.listDecisions("primary", {});
    expect(decisions).toHaveLength(1);
    expect(decisions[0].status).toBe("proposed");
    expect(decisions[0].promptKey).toBe("thesis:condor-bias");
  });

  it("does not propose below the calibration sample floor", async () => {
    const { deps } = baseDeps(falsifiedIdeas(3));

    const report = (await (
      await handleTelemetryReconcileRoute(deps)
    ).json()) as TelemetryReconcileReport;

    expect(report.imported).toBe(3);
    expect(report.calibrationsCreated).toBe(0);
    expect(report.calibrationError).toBeNull();
  });

  it("reports a proposal-pass failure without failing the landed import", async () => {
    const store = new InMemoryTelemetryAdapter();
    const engine = new TelemetryCalibrationEngine(store);
    engine.proposeCalibrations = async () => {
      throw new Error("calibration store unavailable");
    };
    const { deps } = baseDeps(falsifiedIdeas(24), store);

    const response = await handleTelemetryReconcileRoute({ ...deps, engine });
    const report = (await response.json()) as TelemetryReconcileReport;

    expect(response.status).toBe(200);
    expect(report.imported).toBe(24);
    expect(report.calibrationsCreated).toBe(0);
    expect(report.calibrationError).toContain("calibration store unavailable");
    // The rows are durable even though the proposal pass failed.
    expect(await store.queryRealizations("primary", {})).toHaveLength(24);
  });

  it("keeps the admin gate on the reconcile path", async () => {
    const { deps } = baseDeps(falsifiedIdeas(2));
    expect(
      (await handleTelemetryReconcileRoute({ ...deps, session: null })).status,
    ).toBe(401);
    expect(
      (
        await handleTelemetryReconcileRoute({
          ...deps,
          isPlatformAdmin: false,
        })
      ).status,
    ).toBe(403);
  });
});
