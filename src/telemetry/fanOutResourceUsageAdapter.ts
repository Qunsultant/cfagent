/**
 * Fan-out ResourceUsagePort (issue #1819).
 *
 * One measured event to every sink: the Analytics Engine stream (the
 * aligned transport) AND the D1 projection (the queryable store the
 * ScheduledAgent rollup/alert/comparison goals read). A failing sink
 * never blocks the others and never throws to the op path — the same
 * best-effort contract as the observability adapter.
 */
import type { ResourceUsageEvent, ResourceUsagePort } from "./resourceUsagePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "telemetry/fanOutResourceUsageAdapter",
});

export class FanOutResourceUsageAdapter implements ResourceUsagePort {
  constructor(private readonly sinks: ResourceUsagePort[]) {}

  async record(event: ResourceUsageEvent): Promise<void> {
    for (const sink of this.sinks) {
      try {
        await sink.record(event);
      } catch (error) {
        structuredLog.warn("resource_usage.fan_out_sink_failed", {
          message: "[resource-usage] fan-out sink failed",
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}
