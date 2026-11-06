/**
 * Analytics Engine ResourceUsagePort adapter (issue #1819).
 *
 * This IS #1743's transport, not a second pipeline: a resource event is
 * converted to the landed ObservabilityEvent shape (`resource.sql_op`) and
 * written through the same sink the Foundation observability wiring uses —
 * Analytics Engine in production, console degradation when unbound. The
 * adapter adds no aggregation, no rollup, and no alerting; aggregation is
 * `bucketTotals` over the stream, and the comparison against dashboard
 * curves is a separate, explicit step (see the #1819 measurement doc).
 */
import type { ObservabilitySink } from "../observability/observabilityPorts";
import {
  toObservabilityEvent,
  type ResourceUsageEvent,
  type ResourceUsagePort,
} from "./resourceUsagePorts";
import { createStructuredLogger } from "../observability/structuredLogger";
import { createObservabilitySink } from "../observability/createObservabilityPorts";

/** Issue #3515 S3 — module logger on the S2 structured-logging seam. */
const structuredLog = createStructuredLogger(createObservabilitySink({}), {
  component: "telemetry/resourceUsageObservabilityAdapter",
});

export class ObservabilityResourceUsageAdapter implements ResourceUsagePort {
  constructor(private readonly sink: ObservabilitySink) {}

  async record(event: ResourceUsageEvent): Promise<void> {
    try {
      await this.sink.write(toObservabilityEvent(event));
    } catch (error) {
      structuredLog.warn("resource_usage.observability_sink_failed", {
        message: "[resource-usage] observability sink failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
